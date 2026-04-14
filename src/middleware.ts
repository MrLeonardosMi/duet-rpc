export interface MiddlewareContext {
  method: string;
  params: unknown;
  side: string;
  peer: string;
}

export type NextFn = () => Promise<unknown>;

export type MiddlewareFn = (ctx: MiddlewareContext, next: NextFn) => Promise<unknown>;

export function runMiddleware(
  middlewares: MiddlewareFn[],
  ctx: MiddlewareContext,
  handler: () => Promise<unknown>
): Promise<unknown> {
  let index = -1;

  function dispatch(i: number): Promise<unknown> {
    if (i <= index) {
      return Promise.reject(new Error('next() called multiple times'));
    }
    index = i;
    if (i >= middlewares.length) {
      return handler();
    }
    const fn = middlewares[i];
    return fn(ctx, () => dispatch(i + 1));
  }

  return dispatch(0);
}
