debugger;

export function missingThrow(): void {
  new Error("not thrown");
}

enum DuplicateValue {
  First = 1,
  Second = 1,
}

export const thenable = { then() {} };
