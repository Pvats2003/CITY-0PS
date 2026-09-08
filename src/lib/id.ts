import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const gen = customAlphabet(alphabet, 10);

export function id(prefix?: string): string {
  return prefix ? `${prefix}_${gen()}` : gen();
}
