#!/usr/bin/env node
// Ported to TypeScript from rnbennett/supernote-cloud (supernote_cloud/cli.py),
// Apache-2.0, original work © Julian Prester. Modified by the supernote-cli authors:
// token read from SUPERNOTE_TOKEN, nothing written to disk except downloads,
// Unix-style targets, and guards against overwriting or deleting by accident. See NOTICE.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SupernoteClient, type CloudItem } from "./client.ts";
import { AccessTokenRejected, ApiError, IdentityVerificationRequired } from "./errors.ts";
import { createPrompter } from "./prompt.ts";

const TOKEN_ENV = "SUPERNOTE_TOKEN";
const MAX_VERIFICATION_ATTEMPTS = 3;

const USAGE = `Usage: supernote <command> [options]

Commands:
  login [--email <email>]       Log in and print an access token to stdout
  ls [path] [--json]            List a folder (default: root)
  walk [path]                   List every folder below path, recursively
  get <path> [-o dir] [--pdf | --png] [--pages 1,2]
                                Download a file, or render a .note as PDF/PNG
  put <file>... <folder> [--force]
                                Upload local files; --force replaces files of the same name
  mkdir <path> [-p]             Create a folder; -p also creates missing parents
  rename <path> <new-name>      Rename a file or folder in place
  mv <path>... <folder>         Move files and folders into a folder
  cp <path>... <folder>         Copy files and folders into a folder
  rm <path>... [-r] [-y]        Delete; -r for folders with contents, -y to skip the prompt

Every command except login reads the access token from ${TOKEN_ENV}.

Options:
  -h, --help                    Show this help
  -v, --version                 Show the version`;

class UsageError extends Error {}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function clientFromEnv(): SupernoteClient {
  const accessToken = process.env[TOKEN_ENV];
  if (!accessToken) {
    throw new UsageError(
      `${TOKEN_ENV} is not set.\n` +
        `Get a token with \`supernote login\` on a machine you trust, then provide it as ${TOKEN_ENV} (see README).`,
    );
  }
  return new SupernoteClient({ accessToken });
}

function icon(item: CloudItem): string {
  return item.isFolder ? "📁" : "📄";
}

async function login(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { email: { type: "string" } } });
  const prompter = createPrompter();
  try {
    const email = values.email ?? (await prompter.ask("Email: "));
    const password = await prompter.ask("Password: ", { hidden: true });
    const client = new SupernoteClient();

    let token: string;
    try {
      token = await client.login(email, password);
    } catch (error) {
      if (!(error instanceof IdentityVerificationRequired)) throw error;
      token = await verify(client, email, error.timestamp, prompter);
    }
    process.stderr.write("Login successful. Access token:\n");
    process.stdout.write(`${token}\n`);
  } finally {
    prompter.close();
  }
}

/** Identity verification loop: the server allows about two minutes per code. */
async function verify(
  client: SupernoteClient,
  email: string,
  timestamp: string,
  prompter: ReturnType<typeof createPrompter>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_VERIFICATION_ATTEMPTS; attempt++) {
    process.stderr.write("Verification required. Sending a code to your email...\n");
    const validCodeKey = await client.sendVerificationCode(email, timestamp);
    const code = await prompter.ask("Enter the 6-digit code (within 2 minutes): ");
    try {
      return await client.verifyCode(email, code, validCodeKey, timestamp);
    } catch (error) {
      if (!(error instanceof IdentityVerificationRequired)) throw error;
      timestamp = error.timestamp;
      process.stderr.write("Code expired. Requesting a new one...\n");
    }
  }
  throw new ApiError("Too many failed verification attempts");
}

async function ls(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean" } },
  });
  const items = await clientFromEnv().ls(positionals[0]);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }
  for (const item of items) process.stdout.write(`${icon(item)} ${item.fileName}\n`);
}

async function walk(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  for await (const { path, dirs, files } of clientFromEnv().walk(positionals[0])) {
    process.stdout.write(`\n${path}\n`);
    for (const item of [...dirs, ...files]) process.stdout.write(`  ${icon(item)} ${item.fileName}\n`);
  }
}

function parsePages(value: string | undefined): number[] {
  if (!value) return [];
  const pages = value.split(",").map((part) => Number(part.trim()));
  if (pages.some((page) => !Number.isInteger(page) || page < 1)) {
    throw new UsageError("--pages must be comma-separated page numbers, e.g. 1,2,5");
  }
  return pages;
}

async function get(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o", default: "." },
      pdf: { type: "boolean" },
      png: { type: "boolean" },
      pages: { type: "string" },
    },
  });
  const path = positionals[0];
  if (!path) throw new UsageError("get needs a file path, e.g. supernote get /Note/foo.note");
  if (values.pdf && values.png) throw new UsageError("Choose either --pdf or --png, not both");
  const pages = parsePages(values.pages);
  const client = clientFromEnv();

  if (values.pdf) {
    process.stdout.write(`Downloaded PDF to ${await client.getPdf(path, values.output, pages)}\n`);
  } else if (values.png) {
    for (const file of await client.getPng(path, values.output, pages)) {
      process.stdout.write(`Downloaded PNG to ${file}\n`);
    }
  } else {
    process.stdout.write(`Downloaded file to ${await client.get(path, values.output)}\n`);
  }
}

/** Split "<source>... <target>" positionals, needing at least one source. */
function sourcesAndTarget(command: string, positionals: string[], example: string): [string[], string] {
  if (positionals.length < 2) throw new UsageError(`${command} needs at least one source and a target, e.g. ${example}`);
  return [positionals.slice(0, -1), positionals.at(-1)!];
}

async function put(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { force: { type: "boolean" } } });
  const [files, folder] = sourcesAndTarget("put", positionals, "supernote put ./a.pdf /Document");
  const said = { uploaded: "Uploaded", replaced: "Replaced", unchanged: "Unchanged, skipped" } as const;
  for (const { name, outcome } of await clientFromEnv().put(files, folder, { force: values.force })) {
    process.stdout.write(`${said[outcome]} ${name} in ${folder}\n`);
  }
}

async function mkdir(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { parents: { type: "boolean", short: "p" } },
  });
  const path = positionals[0];
  if (!path || positionals.length > 1) throw new UsageError("mkdir needs one folder path, e.g. supernote mkdir /Document/2026");
  await clientFromEnv().mkdir(path, { parents: values.parents });
  process.stdout.write(`Created ${path}\n`);
}

async function rename(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const [path, newName] = positionals;
  if (!path || !newName || positionals.length > 2) {
    throw new UsageError("rename needs a path and a new name, e.g. supernote rename /Note/a.note b.note");
  }
  await clientFromEnv().rename(path, newName);
  process.stdout.write(`Renamed ${path} to ${newName}\n`);
}

/** mv and cp: same arguments, same output, different client call. */
function transfer(command: "mv" | "cp", done: string): (args: string[]) => Promise<void> {
  return async (args) => {
    const { positionals } = parseArgs({ args, allowPositionals: true });
    const [paths, folder] = sourcesAndTarget(command, positionals, `supernote ${command} /Note/a.note /Note/Archive`);
    await clientFromEnv()[command](paths, folder);
    for (const path of paths) process.stdout.write(`${done} ${path} to ${folder}\n`);
  };
}

const mv = transfer("mv", "Moved");
const cp = transfer("cp", "Copied");

/** Deletion cannot be undone from here: ask on a terminal, demand --yes everywhere else. */
async function rm(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { recursive: { type: "boolean", short: "r" }, yes: { type: "boolean", short: "y" } },
  });
  if (positionals.length === 0) throw new UsageError("rm needs at least one path, e.g. supernote rm /Note/a.note");
  const client = clientFromEnv();
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new UsageError("rm needs --yes when not run from a terminal");
    const prompter = createPrompter();
    try {
      process.stderr.write(`About to delete${values.recursive ? " (folders with their contents)" : ""}:\n`);
      for (const path of positionals) process.stderr.write(`  ${path}\n`);
      const answer = await prompter.ask("Delete? [y/N] ");
      if (!/^y(es)?$/i.test(answer)) {
        process.stderr.write("Nothing deleted.\n");
        return;
      }
    } finally {
      prompter.close();
    }
  }
  await client.rm(positionals, { recursive: values.recursive });
  for (const path of positionals) process.stdout.write(`Deleted ${path}\n`);
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  login,
  ls,
  walk,
  get,
  put,
  mkdir,
  rename,
  mv,
  cp,
  rm,
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  const run = commands[command];
  if (!run) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
    return 1;
  }

  try {
    await run(rest);
    return 0;
  } catch (error) {
    if (error instanceof AccessTokenRejected) {
      process.stderr.write(
        `Supernote Cloud rejected ${TOKEN_ENV}: it has expired or is wrong.\n` +
          `Run \`supernote login\` again on a machine you trust and update the secret (see README).\n`,
      );
    } else if (error instanceof UsageError || error instanceof ApiError) {
      process.stderr.write(`Error: ${error.message}\n`);
    } else if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`Error: ${error.message}\n`);
    } else {
      throw error;
    }
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
