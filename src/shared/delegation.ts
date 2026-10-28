/** A raw frame fanned out by a remote Otto's bridge (wire frame minus nothing; routed by `sessionId`). */
export type RemoteEvent = { type: string; kind?: string; sessionId?: string; [k: string]: unknown };
