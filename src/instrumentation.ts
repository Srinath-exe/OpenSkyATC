/* Server start: the feedback reading job looks for reports a stopped server left waiting. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') (await import('./lib/feedback/sweeper')).kick(true);
}
