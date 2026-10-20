import { EventEmitter } from "node:events";

/** A logical socket has no network resources or authority of its own. */
export class VirtualSessionSocket extends EventEmitter {
  readyState = 1;
  constructor(
    private readonly output: (data: string | Uint8Array) => Promise<void>,
    private readonly ended: (code: number, reason: string) => void,
    private readonly buffered: () => number,
    private readonly transformHello: (data: string) => string,
  ) {
    super();
  }
  get bufferedAmount(): number {
    return this.buffered();
  }
  private helloPending = true;
  feed(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    if (this.helloPending) {
      if (typeof data !== "string") {
        this.close(1008, "Expected hello");
        return;
      }
      try {
        data = this.transformHello(data);
      } catch {
        this.close(1008, "Invalid hello");
        return;
      }
      this.helloPending = false;
    }
    this.emit("message", typeof data === "string" ? data : Buffer.from(data));
  }
  async send(data: string | Uint8Array | ArrayBuffer): Promise<void> {
    if (this.readyState !== 1) throw new Error("Host channel closed");
    await this.output(
      typeof data === "string" || data instanceof Uint8Array ? data : new Uint8Array(data),
    );
  }
  close(code = 1000, reason = "Host channel closed"): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.ended(code, reason);
    this.emit("close", 1000, "Host channel closed");
  }
}
