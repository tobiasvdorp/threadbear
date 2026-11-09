// A thread's messages as a small live tail plus older pages read once.
//
// Past messages don't change, so only the newest few need watching. Raising a
// live query's limit instead re-reads everything loaded for each message that
// arrives: 80 rows (about 40 KB) to start, and up to 2000 after scrolling back.
// Pictures have a live query of their own (phone:images), as one can finish
// uploading well after its row has left the tail.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { useLiveQuery } from './live';
import { mergeOlder, mergeTail, type Held } from './transcript-merge';

const TAIL = 30;
const OLDER_PAGE = 200;
// What a thread opens with, above the tail.
const FIRST_OLDER = 50;

type Row = FunctionReturnType<typeof api.phone.messages>['messages'][number];
type Picture = FunctionReturnType<typeof api.phone.images>[number];

export type Transcript = { messages: Row[]; images: Picture[]; hasMore: boolean; loadingMore: boolean; loadMore: () => void };

export function useTranscript(token: string, threadId: string): Transcript | undefined {
  const convex = useConvex();
  const tail = useLiveQuery(api.phone.messages, { token, threadId, limit: TAIL, tools: true, noImages: true });
  const [held, setHeld] = useState<Held<Row>>();
  const heldRef = useRef<Held<Row>>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  // Which page read is the current one. A gap starts over, and a read begun
  // before it mustn't land in what replaced it: that would leave a hole
  // between the two with nothing to say so.
  const reading = useRef(0);
  const busy = useRef(false);

  const older = useCallback(
    async (limit: number) => {
      const from = heldRef.current;
      if (busy.current || !from?.hasMore || !from.rows.size) {
        setHeld(heldRef.current);
        return;
      }
      const mine = ++reading.current;
      busy.current = true;
      setLoadingMore(true);
      try {
        const beforeSeq = Math.min(...from.rows.keys());
        const page = await convex.query(api.phone.messages, { token, threadId, beforeSeq, limit, tools: true, noImages: true });
        if (mine === reading.current) heldRef.current = mergeOlder(heldRef.current ?? from, page);
      } catch (e) {
        // What's held still shows; "Load earlier messages" can try again.
        console.warn('could not load earlier messages', e);
      } finally {
        if (mine === reading.current) {
          busy.current = false;
          setLoadingMore(false);
          setHeld(heldRef.current);
        }
      }
    },
    [convex, token, threadId],
  );

  useEffect(() => {
    if (!tail) return;
    const opening = !heldRef.current;
    const { held: next, gap } = mergeTail(heldRef.current, tail);
    heldRef.current = next;
    if (gap) {
      reading.current++;
      busy.current = false;
    }
    // Opening shows nothing until the first older page is in too, so rows
    // don't appear above what's on screen and push it out of place.
    if (opening || gap) void older(FIRST_OLDER);
    else setHeld(next);
  }, [tail, older]);

  const loadMore = useCallback(() => void older(OLDER_PAGE), [older]);
  const oldest = held?.rows.size ? Math.min(...held.rows.keys()) : 0;
  const images = useLiveQuery(api.phone.images, held ? { token, threadId, from: held.hasMore ? oldest : 0 } : 'skip');
  // The rows' pictures from the last answer while a wider range comes in.
  const shown = useRef<Picture[]>([]);
  if (images) shown.current = images;
  // The same array until the rows change: work links' lookups are remembered
  // per array, with a budget per array (thread-links.ts, findStep), and a new
  // one each render started both again.
  const messages = useMemo(() => (held ? [...held.rows.values()].sort((a, b) => a.seq - b.seq) : []), [held]);
  if (!held) return undefined;
  return { messages, images: shown.current, hasMore: held.hasMore, loadingMore, loadMore };
}
