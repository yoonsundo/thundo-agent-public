import { create } from 'zustand';

export interface DrawnCard {
  cardId: number;
  reversed: boolean;
}

interface TarotResult {
  id: string;
  interpretation: string;
}

interface TarotState {
  topic: string;
  drawn: DrawnCard[];
  result: TarotResult | null;
  setTopic: (topic: string) => void;
  setDrawn: (drawn: DrawnCard[]) => void;
  setResult: (result: TarotResult) => void;
  reset: () => void;
}

export const useTarotStore = create<TarotState>((set) => ({
  topic: '',
  drawn: [],
  result: null,
  setTopic: (topic) => set({ topic }),
  setDrawn: (drawn) => set({ drawn }),
  setResult: (result) => set({ result }),
  reset: () => set({ topic: '', drawn: [], result: null }),
}));
