// Homes has no student directory. This keeps Works' planner contract while
// never offering, storing or fetching student links.
export function studentPicker() {
  return {
    load: () => Promise.resolve(), find: () => undefined, matches: () => [], hint: () => '',
    select() {}, students: () => [], reset() {}, link: () => '',
    chips(container) { container?.replaceChildren(); },
    ready: () => true, failed: () => false,
    originStudent: async () => null,
  };
}
