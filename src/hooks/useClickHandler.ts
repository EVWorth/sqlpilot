import { useRef } from "react";

const DOUBLE_CLICK_DELAY_MS = 250;

/**
 * Returns a `makeClickHandler` factory bound to a shared timer map.
 * Each call to `makeClickHandler(key, onSingle, onDouble)` returns an onClick
 * handler that distinguishes single clicks from double clicks:
 *   - First click arms a timer; if no second click arrives within the delay,
 *     `onSingle` fires.
 *   - Second click within the delay cancels the timer and fires `onDouble`.
 */
export function useClickHandler() {
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const makeClickHandler = (
    key: string,
    onSingle: () => void,
    onDouble: () => void,
  ) => {
    return () => {
      const pending = timers.current.get(key);
      if (pending) {
        clearTimeout(pending);
        timers.current.delete(key);
        onDouble();
      } else {
        const timer = setTimeout(() => {
          timers.current.delete(key);
          onSingle();
        }, DOUBLE_CLICK_DELAY_MS);
        timers.current.set(key, timer);
      }
    };
  };

  return makeClickHandler;
}
