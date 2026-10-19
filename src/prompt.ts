import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export interface Prompter {
  ask(question: string, options?: { hidden?: boolean }): Promise<string>;
  close(): void;
}

/** Line prompts written to stderr, so stdout stays clean for piping. */
export function createPrompter(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Prompter {
  let muted = false;
  const echo = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input, output: echo, terminal: Boolean(input.isTTY) });

  return {
    async ask(question, { hidden = false } = {}) {
      output.write(question);
      muted = hidden;
      try {
        return (await rl.question("")).trim();
      } finally {
        muted = false;
        if (hidden && input.isTTY) output.write("\n");
      }
    },
    close() {
      rl.close();
    },
  };
}
