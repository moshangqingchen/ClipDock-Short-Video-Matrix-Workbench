import type { WebContents } from "electron";

interface Owner {
  count: number;
  attachedHere: boolean;
  invalid: boolean;
}
const owners = new WeakMap<WebContents, Owner>();

/** Uploads and identity observation share one connection, including asynchronous overlaps. */
export function acquireDebugger(contents: WebContents): () => void {
  let owner = owners.get(contents);
  if (!owner || owner.invalid) {
    const attachedHere = !contents.debugger.isAttached();
    if (attachedHere) contents.debugger.attach("1.3");
    owner = { count: 0, attachedHere, invalid: false };
    owners.set(contents, owner);
    const captured = owner;
    contents.debugger.once("detach", () => {
      captured.invalid = true;
      if (owners.get(contents) === captured) owners.delete(contents);
    });
  }
  owner.count++;
  const current = owner;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--current.count !== 0 || current.invalid) return;
    if (owners.get(contents) === current) owners.delete(contents);
    if (current.attachedHere && !contents.isDestroyed() && contents.debugger.isAttached())
      contents.debugger.detach();
  };
}
