import { stringify, parse } from 'devalue';

export function serialize(value: unknown): string {
  return stringify(value);
}

export function deserialize(data: string): unknown {
  return parse(data);
}
