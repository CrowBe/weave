import { MemoryDispatchJournal } from '../src/dispatch.js';
import { dispatchJournalContract } from './dispatch-journal-contract.js';

dispatchJournalContract('MemoryDispatchJournal', () => new MemoryDispatchJournal());
