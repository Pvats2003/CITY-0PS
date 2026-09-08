import { create } from "zustand";

interface UIState {
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  systemStatusOpen: boolean;
  setSystemStatusOpen: (v: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  systemStatusOpen: false,
  setSystemStatusOpen: (v) => set({ systemStatusOpen: v }),
}));
