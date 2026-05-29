import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';

// --- Secure storage adapter for Zustand persist ---

const secureStorage: StateStorage = {
  getItem: async (name: string) => {
    return await SecureStore.getItemAsync(name);
  },
  setItem: async (name: string, value: string) => {
    await SecureStore.setItemAsync(name, value);
  },
  removeItem: async (name: string) => {
    await SecureStore.deleteItemAsync(name);
  },
};

// --- Types ---

export interface Machine {
  /** deviceId returned from pairing */
  id: string;
  /** User-facing label, e.g. "Gaming PC" */
  label: string;
  /** Base URL including port, e.g. "http://100.64.0.1:17829" */
  baseUrl: string;
  /** Bearer token from pairing */
  token: string;
  /** Timestamp of last successful WS auth */
  lastSeen: number;
  /** Remote OS: 'darwin' | 'win32' | 'linux' */
  platform?: string;
}

interface AppStore {
  machines: Machine[];
  activeMachineId: string | null;

  addMachine(m: Machine): void;
  removeMachine(id: string): void;
  updateMachine(id: string, patch: Partial<Omit<Machine, 'id'>>): void;
  setActiveMachine(id: string | null): void;
  getMachine(id: string): Machine | undefined;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      machines: [],
      activeMachineId: null,

      addMachine(m) {
        set((s) => ({
          machines: [...s.machines.filter((x) => x.id !== m.id), m],
        }));
      },

      removeMachine(id) {
        set((s) => ({
          machines: s.machines.filter((x) => x.id !== id),
          activeMachineId: s.activeMachineId === id ? null : s.activeMachineId,
        }));
      },

      updateMachine(id, patch) {
        set((s) => ({
          machines: s.machines.map((x) => (x.id === id ? { ...x, ...patch } : x)),
        }));
      },

      setActiveMachine(id) {
        set({ activeMachineId: id });
      },

      getMachine(id) {
        return get().machines.find((x) => x.id === id);
      },
    }),
    {
      name: 'otto-machines',
      storage: createJSONStorage(() => secureStorage),
      // Only persist machines and activeMachineId
      partialize: (state) => ({
        machines: state.machines,
        activeMachineId: state.activeMachineId,
      }),
    },
  ),
);
