import { create } from 'zustand';

export interface DreamInput {
  dreamText: string;
  mood: string;
}

export interface DreamSymbol {
  emoji: string;
  name: string;
  meaning: string;
}

export interface DreamResultPayload {
  id: string;
  verdict: '길몽' | '흉몽' | '평몽';
  verdictSummary: string;
  symbols: DreamSymbol[];
  luckyNumbers: number[];
  interpretation: string;
}

interface DreamState {
  input: DreamInput;
  result: DreamResultPayload | null;
  setInput: (input: Partial<DreamInput>) => void;
  setResult: (result: DreamResultPayload) => void;
  reset: () => void;
}

const defaultInput: DreamInput = {
  dreamText: '',
  mood: '',
};

export const useDreamStore = create<DreamState>((set) => ({
  input: defaultInput,
  result: null,
  setInput: (partial) =>
    set((state) => ({ input: { ...state.input, ...partial } })),
  setResult: (result) => set({ result }),
  reset: () => set({ input: defaultInput, result: null }),
}));
