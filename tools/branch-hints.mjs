// Clang does not emit Wasm branch hints, but V8 uses them to keep cold blocks
// and their register spills out of the hot loop. Derive them structurally: a
// branch is unlikely when taking it calls a cold function, and likely when it
// skips one or repeats a loop. Every other branch stays unhinted.

const SECTION_CUSTOM = 0;
const SECTION_IMPORT = 2;
const SECTION_CODE = 10;

function reader(bytes, offset = 0) {
  return {
    offset,
    byte() {
      return bytes[this.offset++];
    },
    u32() {
      let result = 0;
      let shift = 0;
      for (;;) {
        const byte = bytes[this.offset++];
        result |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) return result >>> 0;
        shift += 7;
      }
    },
    signed() {
      for (;;) if (!(bytes[this.offset++] & 0x80)) return;
    },
    skip(length) {
      this.offset += length;
    },
  };
}

function leb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function sections(bytes) {
  const input = reader(bytes, 8);
  const list = [];
  while (input.offset < bytes.length) {
    const start = input.offset;
    const id = input.byte();
    const size = input.u32();
    const body = input.offset;
    input.skip(size);
    list.push({ id, start, body, end: input.offset });
  }
  return list;
}

function customName(bytes, section) {
  const input = reader(bytes, section.body);
  const length = input.u32();
  return {
    name: Buffer.from(bytes.subarray(input.offset, input.offset + length)).toString(),
    offset: input.offset + length,
  };
}

function functionNames(bytes, list) {
  const names = new Map();
  for (const section of list) {
    if (section.id !== SECTION_CUSTOM) continue;
    const { name, offset } = customName(bytes, section);
    if (name !== 'name') continue;
    const input = reader(bytes, offset);
    while (input.offset < section.end) {
      const kind = input.byte();
      const size = input.u32();
      const end = input.offset + size;
      if (kind === 1) {
        for (let count = input.u32(); count--; ) {
          const index = input.u32();
          const length = input.u32();
          names.set(
            Buffer.from(bytes.subarray(input.offset, input.offset + length)).toString(),
            index,
          );
          input.skip(length);
        }
      }
      input.offset = end;
    }
  }
  return names;
}

function memarg(input) {
  input.u32();
  input.u32();
}

// Decode one function body into instructions with only the immediates needed
// for control flow. Unknown opcodes fail the build rather than mis-hinting.
function decode(bytes, start, end) {
  const input = reader(bytes, start);
  for (let groups = input.u32(); groups--; ) {
    input.u32();
    input.byte();
  }
  const instructions = [];
  while (input.offset < end) {
    const offset = input.offset - start;
    const opcode = input.byte();
    const instruction = { offset, opcode };
    if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
      const type = bytes[input.offset];
      if (type === 0x40 || (type >= 0x6f && type <= 0x7f)) input.skip(1);
      else input.signed();
    } else if (opcode === 0x0c || opcode === 0x0d) instruction.label = input.u32();
    else if (opcode === 0x0e) {
      for (let count = input.u32() + 1; count--; ) input.u32();
    } else if (opcode === 0x10) instruction.callee = input.u32();
    else if (opcode === 0x11) {
      input.u32();
      input.u32();
    } else if (opcode === 0x1c) {
      for (let count = input.u32(); count--; ) input.byte();
    } else if (opcode >= 0x20 && opcode <= 0x26) input.u32();
    else if (opcode >= 0x28 && opcode <= 0x3e) memarg(input);
    else if (opcode === 0x3f || opcode === 0x40) input.byte();
    else if (opcode === 0x41 || opcode === 0x42) input.signed();
    else if (opcode === 0x43) input.skip(4);
    else if (opcode === 0x44) input.skip(8);
    else if (opcode === 0xfc) {
      const sub = input.u32();
      if (sub === 8 || sub === 12 || sub === 14) {
        input.u32();
        input.u32();
      } else if (sub === 9 || sub === 13 || (sub >= 15 && sub <= 17)) input.u32();
      else if (sub === 10) input.skip(2);
      else if (sub === 11) input.skip(1);
      else if (sub > 7) throw new Error(`Unsupported 0xfc opcode ${sub}`);
    } else if (opcode === 0xfd) {
      const sub = input.u32();
      if (sub <= 11 || sub === 92 || sub === 93) memarg(input);
      else if (sub === 12 || sub === 13) input.skip(16);
      else if (sub >= 21 && sub <= 34) input.skip(1);
      else if (sub >= 84 && sub <= 91) {
        memarg(input);
        input.skip(1);
      }
    } else if (
      !(opcode <= 0x01 || opcode === 0x05 || opcode === 0x0b || opcode === 0x0f) &&
      !(opcode === 0x1a || opcode === 0x1b) &&
      !(opcode >= 0x45 && opcode <= 0xc4)
    )
      throw new Error(`Unsupported opcode 0x${opcode.toString(16)}`);
    instructions.push(instruction);
  }
  if (input.offset !== end) throw new Error('Function body decoding overran its end');
  return instructions;
}

const isControl = (opcode) => opcode <= 0x05 || (opcode >= 0x0b && opcode <= 0x0f);

// Does straight-line code from index i, at the current nesting depth, call a
// cold function before control flow could leave or branch?
function reachesCold(instructions, i, cold) {
  for (let depth = 0; i < instructions.length; i++) {
    const { opcode, callee } = instructions[i];
    if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) depth++;
    else if (opcode === 0x0b || opcode === 0x05) {
      if (!depth--) return false;
    } else if (depth === 0 && opcode === 0x10 && cold.has(callee)) return true;
    else if (depth === 0 && isControl(opcode)) return false;
  }
  return false;
}

function hintsFor(instructions, cold) {
  const ends = new Map();
  const stack = [];
  instructions.forEach((instruction, index) => {
    if (instruction.opcode === 0x02 || instruction.opcode === 0x03 || instruction.opcode === 0x04)
      stack.push(index);
    else if (instruction.opcode === 0x0b && stack.length) ends.set(stack.pop(), index);
  });
  const hints = [];
  const open = [];
  instructions.forEach((instruction, index) => {
    const { opcode } = instruction;
    if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
      open.push(index);
      if (opcode === 0x04) {
        // Condition true enters the then-arm.
        if (reachesCold(instructions, index + 1, cold)) hints.push([instruction.offset, 0]);
      }
    } else if (opcode === 0x0b) open.pop();
    else if (opcode === 0x0d) {
      // A label past every open construct exits the function: leave it unhinted.
      const target = open[open.length - 1 - instruction.label];
      if (target === undefined) return;
      if (instructions[target].opcode === 0x03) return;
      else if (reachesCold(instructions, ends.get(target) + 1, cold))
        hints.push([instruction.offset, 0]);
      else if (reachesCold(instructions, index + 1, cold)) hints.push([instruction.offset, 1]);
    }
  });
  return hints;
}

// Returns the module with every custom section removed and branch hints added
// before the code section, plus a per-function summary for the build record.
export function addBranchHints(bytes, coldNames) {
  const list = sections(bytes);
  // Code bodies are then numbered exactly like the function index space.
  if (list.some((section) => section.id === SECTION_IMPORT))
    throw new Error('Branch hints assume a module without imports');
  const names = functionNames(bytes, list);
  const cold = new Set(
    coldNames.map((name) => {
      if (!names.has(name)) throw new Error(`Missing cold function ${name}`);
      return names.get(name);
    }),
  );
  const code = list.find((section) => section.id === SECTION_CODE);
  const input = reader(bytes, code.body);
  const functions = [];
  for (let index = 0, count = input.u32(); index < count; index++) {
    const size = input.u32();
    const hints = hintsFor(decode(bytes, input.offset, input.offset + size), cold);
    if (hints.length) functions.push({ index, hints });
    input.skip(size);
  }
  const payload = [...leb(functions.length)];
  for (const { index, hints } of functions) {
    payload.push(...leb(index), ...leb(hints.length));
    for (const [offset, value] of hints) payload.push(...leb(offset), 1, value);
  }
  const name = Buffer.from('metadata.code.branch_hint');
  const content = [...leb(name.length), ...name, ...payload];
  const parts = [bytes.subarray(0, 8)];
  for (const section of list) {
    if (section.id === SECTION_CUSTOM) continue;
    if (section.id === SECTION_CODE)
      parts.push(Buffer.from([SECTION_CUSTOM, ...leb(content.length), ...content]));
    parts.push(bytes.subarray(section.start, section.end));
  }
  const byName = new Map([...names].map(([functionName, index]) => [index, functionName]));
  return {
    bytes: Buffer.concat(parts),
    summary: functions.map(({ index, hints }) => ({
      function: byName.get(index) ?? `#${index}`,
      likely: hints.filter(([, value]) => value).length,
      unlikely: hints.filter(([, value]) => !value).length,
    })),
  };
}
