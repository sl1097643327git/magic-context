export interface CtxExpandArgs {
    start?: number;
    end?: number;
    /** Verbose range view: each message + tool call shown separately, with ids. */
    verbose?: boolean;
    /** Full untruncated recovery of one message (any role) by its message id. */
    id?: string;
}
