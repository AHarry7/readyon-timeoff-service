import { randomUUID } from "crypto";

// Tell Jest to use Node's built-in crypto module to generate v4 UUIDs
export const v4 = () => randomUUID();
export default { v4 };
