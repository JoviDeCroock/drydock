// Preact 11 types an element's props as a union keyed on the attribute that
// limits its ARIA roles (`href` on <a>, `type` on <input>, `multiple` on
// <select>). A plain Omit flattens that union, and the result no longer spreads
// back onto the element, so wrappers omit from each member instead.
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
