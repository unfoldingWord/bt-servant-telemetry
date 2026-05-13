/**
 * @pqina/flip ships no TypeScript types. We only touch the small subset
 * of the Tick API needed to drive the hero counter: DOM.create / destroy
 * plus the `.value` setter on the returned instance.
 */
declare module '@pqina/flip' {
  type TickInstance = {
    value: string | number;
    root: HTMLElement;
  };
  type Tick = {
    DOM: {
      create: (el: HTMLElement) => TickInstance;
      destroy: (el: HTMLElement) => void;
    };
  };
  const Tick: Tick;
  export default Tick;
}

declare module '@pqina/flip/dist/flip.css';
