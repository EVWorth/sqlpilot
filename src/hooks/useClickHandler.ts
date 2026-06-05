import { useRef } from "react";

const DOUBLE_CLICK_DELAY_MS = 250;

/**
 * Returns a `makeClickHandler` factory bound to a shared timer map.
 * Each call to `makeClickHandler(key, onSingle, onDouble)` returns an onClick
 * handler that distinguishes single clicks from double clicks:
 *   - First click arms a timer; if no second click arrives within the delay,
 *     `onSingle` fires.
 *   - Second click within the delay cancels the timer and fires `onDouble`.
 *
 * Callbacks are stored in a ref so that timers always fire with the most
 * recent callback values, even if the component re-renders between clicks.
 */
export function useClickHandler() {
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const callbacks = useRef<Map<string, { single: () => void; double: () => void }>>(new Map());

  const makeClickHandler = (
    key: string,
    onSingle: () => void,
    onDouble: () => void,
  ) => {
    callbacks.current.set(key, { single: onSingle, double: onDouble });

    return () => {
      const cb = callbacks.current.get(key);
      const pending = timers.current.get(key);
      if (pending) {
        clearTimeout(pending);
        timers.current.delete(key);
        cb?.double();
      } else {
        const timer = setTimeout(() => {
          timers.current.delete(key);
          callbacks.current.get(key)?.single();
        }, DOUBLE_CLICK_DELAY_MS);
        timers.current.set(key, timer);
      }
    };
  };

  return makeClickHandler;
}
