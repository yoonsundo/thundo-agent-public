import { create } from 'zustand';
import type { SajuResult } from '@/lib/manseryeok';

export interface SajuInput {
  name: string;
  birthDate: string;
  birthTime: string;
  gender: 'male' | 'female' | '';
  fortuneTypes: string[];
}

interface SajuResultPayload {
  id: string;
  pillars: SajuResult;
  interpretations: { type: string; text: string }[];
}

interface SajuState {
  input: SajuInput;
  result: SajuResultPayload | null;
  setInput: (input: Partial<SajuInput>) => void;
  setResult: (result: SajuResultPayload) => void;
  reset: () => void;
}

const defaultInput: SajuInput = {
  name: '',
  birthDate: '',
  birthTime: '',
  gender: '',
  fortuneTypes: ['원국'],
};

export const useSajuStore = create<SajuState>((set) => ({
  input: defaultInput,
  result: null,
  setInput: (partial) =>
    set((state) => ({ input: { ...state.input, ...partial } })),
  setResult: (result) => set({ result }),
  reset: () => set({ input: defaultInput, result: null }),
}));
