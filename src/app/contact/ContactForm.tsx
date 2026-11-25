'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import s from './contact.module.css';

const TOPICS: Array<[string, string]> = [['bug', 'Something is broken'], ['idea', 'An idea'], ['question', 'A question'], ['privacy', 'My data'], ['credits', 'A credit or licence'], ['security', 'A security problem'], ['other', 'Something else']];

/** Goes to the same place as the in-game reports (/api/report); the address is only used to answer. */
export function ContactForm() {
  const asked = useSearchParams().get('topic') ?? '';
  const [topic, setTopic] = React.useState('question');
  React.useEffect(() => { if (TOPICS.some(([k]) => k === asked)) setTopic(asked); }, [asked]);
  const [message, setMessage] = React.useState(''), [email, setEmail] = React.useState(''), [web, setWeb] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'busy' | 'sent' | 'error'>('idle'), [error, setError] = React.useState(''), [ref, setRef] = React.useState('');
  const send = async (ev: React.FormEvent) => {
    ev.preventDefault(); if (state === 'busy') return;
    if (message.trim().length < 10) { setError('Write a little more, so we know what you mean.'); setState('error'); return; }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) { setError('That email address looks incomplete.'); setState('error'); return; }
    setState('busy');
    try {
      const r = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'report', from: 'contact', topic, message: message.trim().slice(0, 8000), email: email.trim() || undefined, website: web || undefined, ua: navigator.userAgent, lang: navigator.language, build: process.env.NEXT_PUBLIC_BUILD }) });
      if (!r.ok) throw new Error(r.status === 429 ? 'Too many messages in a short time. Try again in a few minutes.' : 'It did not go through. Try again, or open an issue on GitHub.');
      setRef(((await r.json()) as { id?: string }).id ?? ''); setState('sent');
    } catch (e) { setError(e instanceof Error && e.message !== 'Failed to fetch' ? e.message : 'No connection. Try again in a moment.'); setState('error'); }
  };
  if (state === 'sent') return <div className={s.sent} role="status" data-testid="contact-sent"><h2>Sent. Thank you.</h2><p>{ref ? <>Your reference is <strong>{ref}</strong>. </> : null}{email ? 'We will answer at the address you gave.' : 'You left no address, so we cannot answer, but we read everything.'}</p><button type="button" className={s.ghost} onClick={() => { setMessage(''); setState('idle'); }}>Send another</button></div>;
  return (
    <form className={s.form} onSubmit={send} noValidate data-testid="contact-form">
      <label className={s.field}><span>About</span><select value={topic} onChange={(e) => setTopic(e.target.value)} data-testid="contact-topic">{TOPICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className={s.field}><span>Message</span><textarea rows={7} required value={message} onChange={(e) => { setMessage(e.target.value); if (state === 'error') setState('idle'); }} placeholder={topic === 'bug' ? 'Which airport, what you did, and what happened' : ''} data-testid="contact-message" aria-invalid={state === 'error' || undefined} aria-describedby={state === 'error' ? 'contact-error' : undefined} /></label>
      <label className={s.field}><span>Your email <i>optional, only to answer you</i></span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="contact-email" /></label>
      <label className={s.trap} aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={web} onChange={(e) => setWeb(e.target.value)} /></label>
      {state === 'error' ? <p className={s.error} id="contact-error" role="alert">{error}</p> : null}
      <div className={s.row}><button type="submit" className={s.send} disabled={state === 'busy'} data-testid="contact-send">{state === 'busy' ? 'Sending' : 'Send'}</button><small>See how we handle it in <a href="/privacy">Privacy</a>.</small></div>
    </form>
  );
}
