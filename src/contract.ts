import type { z } from 'zod';

export type ProcedureDef = {
  input?: z.ZodType<any>;
  output?: z.ZodType<any>;
};

export type ContractSide = Record<string, ProcedureDef>;

export type ContractDef = Record<string, ContractSide>;

/** Infer the implementation type for a contract side. */
export type ImplementationOf<Side extends ContractSide> = {
  [K in keyof Side]: Side[K] extends { input: z.ZodType<infer I>; output: z.ZodType<infer O> }
    ? (input: I) => Promise<O> | O
    : Side[K] extends { input: z.ZodType<infer I> }
      ? (input: I) => Promise<void> | void
      : Side[K] extends { output: z.ZodType<infer O> }
        ? () => Promise<O> | O
        : () => Promise<void> | void;
};

/** Infer the remote proxy type for a contract side. */
export type RemoteOf<Side extends ContractSide> = {
  [K in keyof Side]: Side[K] extends { input: z.ZodType<infer I>; output: z.ZodType<infer O> }
    ? (input: I) => Promise<O>
    : Side[K] extends { input: z.ZodType<infer I> }
      ? (input: I) => Promise<void>
      : Side[K] extends { output: z.ZodType<infer O> }
        ? () => Promise<O>
        : () => Promise<void>;
};

/** Define a bidirectional RPC contract. */
export function createContract<T extends ContractDef>(def: T): T {
  return def;
}
