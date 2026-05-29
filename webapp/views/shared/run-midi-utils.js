/**
 * Purpose: Toggle active CSS state for one virtual MIDI key.
 * How: Looks up the DOM key element from the note map and toggles its `active` class.
 */
export function setMidiUiKeyActive(noteMap, note, active) {
  const key = noteMap.get(note);
  if (!key) return;
  key.classList.toggle('active', active);
}

/**
 * Purpose: Release all computer-keyboard MIDI notes currently latched as active.
 * How: Clears active-note tracking, deactivates corresponding UI keys, and emits `noteOff` for each released note.
 */
export function releaseComputerMidiNotes(activeNotesMap, noteMap, handlers, setActive) {
  const notes = new Set(activeNotesMap.values());
  activeNotesMap.clear();
  for (const note of notes) {
    setActive(noteMap, note, false);
    if (handlers && handlers.noteOff) {
      handlers.noteOff(note);
    }
  }
}

/**
 * Purpose: Detect whether keyboard shortcuts should be ignored due to text-entry focus.
 * How: Returns true for editable elements and common text input/select form controls.
 */
export function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
