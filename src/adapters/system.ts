import { v7 as uuidv7 } from "uuid";
import type { Clock, IdGenerator } from "../usecases/ports.js";

export const systemClock: Clock = { now: () => new Date() };

/** Ids are UUIDv7 made here, not by the database. */
export const randomIds: IdGenerator = {
  newId: () => uuidv7(),
};
