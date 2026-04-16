import type { RpcRequest, RpcResponse } from "@browseruse/shared";

export type Handler = (params: unknown) => Promise<unknown>;

export class Dispatcher {
  private handlers = new Map<string, Handler>();

  register(method: string, h: Handler) {
    this.handlers.set(method, h);
  }

  async handle(req: RpcRequest): Promise<RpcResponse> {
    const h = this.handlers.get(req.method);
    if (!h) {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
    }
    try {
      const result = await h(req.params ?? {});
      return { jsonrpc: "2.0", id: req.id, result };
    } catch (e) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      };
    }
  }
}
