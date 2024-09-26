/**
 * @name tailwind-group-variant
 * @license MIT license.
 * @copyright (c) 2022 Christian Schurr
 * @author Christian Schurr <chris@schurr.dev>
 */

const SEPARATOR_CHARS = [
  // " ", // Space is used as a separator in the FSM
  "\n",
  "\t",
  "\r",
  "\f",
  "\v",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff"
];

const FORBIDDEN_CHARS = ['"', "'", "`", "\\", "[", "\n", "\r"];

const STATES = [
  "idle",
  "parsingText",
  "handlingVariant",
  "openingStack",
  "parsingStackText",
  "handlingStackVariant",
  "closingStack"
] as const;

type State = (typeof STATES)[number];

type MatchType = {
  start: number;
  end: number;
  content: string;
};

type StackType = {
  nestedMatches: Array<Omit<StackType, "nestedMatches"> & { endIdx: number }>;
  matches: Array<string>;
  variant: string;
  startIdx: number;
};

function stackError(machine: TransformMachineState) {
  for (const stack of machine.context.stack) {
    if (stack.nestedMatches.length) {
      for (const nestedStack of stack.nestedMatches) {
        machine.context.matches.push({
          start: nestedStack.startIdx,
          end: nestedStack.endIdx,
          content: nestedStack.matches.map((match) => `${nestedStack.variant}${match}`).join(" ")
        });
      }
    }
  }
  machine.context.stack.length = 0;
  machine.state = "idle";
}

function stackClose(machine: TransformMachineState, idx: number, hasWord: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const currentStack = machine.context.stack.pop()!;

  if (hasWord) {
    currentStack.matches.push(machine.context.content.substring(machine.context.variantStartIdx, idx));
  }

  if (machine.context.stack.length > 0) {
    machine.context.stack[machine.context.stack.length - 1]?.nestedMatches.push({
      ...currentStack,
      endIdx: idx
    });
    machine.state = "closingStack";
  } else {
    // Apply nested variants
    currentStack.matches.push(
      ...currentStack.nestedMatches.flatMap((nestedStack) =>
        nestedStack.matches.map((match) => `${nestedStack.variant}${match}`)
      )
    );

    // Apply root-level variants
    machine.context.matches.push({
      start: currentStack.startIdx,
      end: idx,
      content: currentStack.matches.map((match) => `${currentStack.variant}${match}`).join(" ")
    });
    machine.state = "idle";
  }
}

function openStack(machine: TransformMachineState) {
  machine.state = "openingStack";

  machine.context.stack.push({
    matches: [],
    nestedMatches: [],
    variant: machine.context.content.substring(machine.context.variantStartIdx, machine.context.variantEndIdx + 1),
    startIdx: machine.context.variantStartIdx
  });
}

type TransformMachineState = {
  context: {
    matches: Array<MatchType>;
    stack: Array<StackType>;
    variantStartIdx: number;
    variantEndIdx: number;
    content: string;
  };
  settings: {
    forbiddenChars: Set<string>;
    variantChar: string;
    expandOpen: string;
    expandClose: string;
    separatorChar: string;
  };
  state: State;
};

type TransformMachine = Record<State, (idx: number, char: string, machineState: TransformMachineState) => void>;

const transformMachine: TransformMachine = {
  idle: (idx, char, machineState) => {
    if (!machineState.settings.forbiddenChars.has(char)) {
      machineState.context.variantStartIdx = idx;
      machineState.state = "parsingText";
    }
  },

  parsingText: (idx, char, machineState) => {
    if (char === machineState.settings.variantChar) {
      machineState.context.variantEndIdx = idx;
      machineState.state = "handlingVariant";
    } else if (char === machineState.settings.separatorChar) {
      // Move the variant start to after the separator char, which is a space
      machineState.context.variantStartIdx = idx + 1;
    } else if (machineState.settings.forbiddenChars.has(char)) {
      machineState.state = "idle";
    }
  },

  handlingVariant: (_idx, char, machineState) => {
    if (char === machineState.settings.expandOpen) {
      openStack(machineState);
    } else if (machineState.settings.forbiddenChars.has(char)) {
      machineState.state = "idle";
    } else {
      machineState.state = "parsingText";
    }
  },

  openingStack: (idx, char, machineState) => {
    if (machineState.settings.forbiddenChars.has(char)) {
      stackError(machineState);
    } else if (char === machineState.settings.expandClose) {
      stackError(machineState);
    } else {
      machineState.context.variantStartIdx = idx;
      machineState.state = "parsingStackText";
    }
  },

  parsingStackText: (idx, char, machineState) => {
    if (char === machineState.settings.separatorChar) {
      const contentPiece = machineState.context.content.substring(machineState.context.variantStartIdx, idx);

      // Push the next applicable style to the stack (like "bg-[#FFFF00]")
      machineState.context.stack[machineState.context.stack.length - 1]?.matches.push(contentPiece);
      machineState.state = "openingStack";
    } else if (char === machineState.settings.variantChar) {
      machineState.context.variantEndIdx = idx;
      machineState.state = "handlingStackVariant";
    } else if (char === machineState.settings.expandClose) {
      stackClose(machineState, idx, true);
    }
  },

  handlingStackVariant: (_idx, char, machineState) => {
    if (char === machineState.settings.expandOpen) {
      openStack(machineState);
    } else if (machineState.settings.forbiddenChars.has(char)) {
      stackError(machineState);
    } else {
      machineState.state = "parsingStackText";
    }
  },

  closingStack: (idx, char, machineState) => {
    if (machineState.settings.forbiddenChars.has(char)) {
      stackError(machineState);
    } else if (char === machineState.settings.expandClose) {
      stackClose(machineState, idx, false);
    } else if (char === machineState.settings.separatorChar) {
      machineState.state = "openingStack";
    } else {
      stackError(machineState);
    }
  }
};

function compressWhitespace(str: string) {
  return str
    .replace(/\s+/g, " ") // Replace all whitespace with a single space
    .replace(/\(\s+/g, "(") // Replace "( " with "("
    .replace(/\s+\)/g, ")") // Replace " )" with ")"
    .trim(); // Remove leading/trailing whitespace
}

function transform(content: string) {
  const compressedContent = compressWhitespace(content);

  const machineState: TransformMachineState = {
    context: {
      matches: [],
      stack: [],
      variantStartIdx: 0,
      variantEndIdx: 0,
      content: compressedContent
    },
    state: "idle",
    settings: {
      forbiddenChars: new Set<string>([...FORBIDDEN_CHARS, ...SEPARATOR_CHARS]),
      expandClose: ")",
      expandOpen: "(",
      separatorChar: " ",
      variantChar: ":"
    }
  };

  for (let idx = 0; idx < compressedContent.length; ++idx) {
    const char = compressedContent[idx]!;

    const handleIdxForState = transformMachine[machineState.state];

    handleIdxForState(idx, char, machineState);
  }

  const matches = machineState.context.matches;

  if (matches.length) {
    let prevStart = 0;

    const str = matches.reduce((prev, cur) => {
      const substr = `${prev}${compressedContent.substring(prevStart, cur.start)}${cur.content}`;
      prevStart = cur.end + 1;
      return substr;
    }, "");

    return `${str}${compressedContent.substring(prevStart)}`;
  }

  return compressedContent;
}

export default function createTransformer() {
  return (content: string) => transform(content);
}
