/**
 * Tiny, dependency-free color + logging helper.
 * Honours NO_COLOR, --no-color (via setColor), and non-TTY output.
 */

let colorEnabled =
  process.stdout.isTTY === true && !("NO_COLOR" in process.env);

export function setColor(on: boolean): void {
  colorEnabled = on;
}

function wrap(open: number, close: number) {
  return (s: string): string =>
    colorEnabled ? `[${open}m${s}[${close}m` : s;
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function info(msg: string): void {
  process.stderr.write(msg + "\n");
}

export function out(msg: string): void {
  process.stdout.write(msg + "\n");
}

export function warn(msg: string): void {
  process.stderr.write(c.yellow("! ") + msg + "\n");
}

export function fail(msg: string): never {
  process.stderr.write(c.red("✖ ") + msg + "\n");
  process.exit(1);
}
