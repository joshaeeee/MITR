import { z } from 'zod';

export const optionalStringArg = () =>
  z.preprocess((value) => (value == null ? undefined : value), z.string().optional());
