// Red: a template line that opens with /* is not a comment, so the read below is real.
export const openComment = `
/*`;
export const key = process.env.API_KEY;
/* an ordinary later comment */
export const inline = `key: ${process.env.INLINE ?? `none`}`;
