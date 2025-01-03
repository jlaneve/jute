import type { EditorView } from "@codemirror/view";
import { Channel, invoke } from "@tauri-apps/api/core";
import { encode } from "html-entities";
import { createContext, useContext } from "react";
import { v4 as uuidv4 } from "uuid";
import { StoreApi, createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

type RunCellEvent =
  | { event: "stdout"; data: string }
  | { event: "stderr"; data: string }
  | {
      event: "execute_result";
      data: {
        execution_count: number;
        data: Record<string, any>;
        metadata: Record<string, any>;
      };
    }
  | {
      event: "display_data" | "update_display_data";
      data: {
        data: Record<string, any>;
        metadata: Record<string, any>;
        transient: {
          display_id: string | null;
        } | null;
      };
    }
  | {
      event: "error";
      data: {
        ename: string;
        evalue: string;
        traceback: string[];
      };
    }
  | { event: "disconnect"; data: string };

type NotebookStore = NotebookStoreState & NotebookStoreActions;

export type NotebookStoreState = {
  cellIds: string[];
  cells: {
    [cellId: string]: {
      initialText: string;
      output?: NotebookOutput;
    };
  };
};

export type NotebookOutput = {
  status: "success" | "error";
  output: string;
  displays: { [displayId: string]: string };
};

/** Actions are kept private, only to be used from the `Notebook` class. */
type NotebookStoreActions = {
  addCell: (id: string, initialText: string) => void;
  setOutput: (cellId: string, output: NotebookOutput) => void;
};

type CellHandle = {
  editor?: EditorView;
};

export class Notebook {
  /** ID of the running kernel, populated after the kernel is started. */
  kernelId: string;

  /** Promise that resolves when the kernel is started. */
  kernelStartPromise: Promise<void>;

  /** Zustand object used to reactively update DOM nodes. */
  store: StoreApi<NotebookStore>;

  /** Direct handles to editors and other HTML elements after render. */
  refs: Map<string, CellHandle>;

  constructor() {
    this.kernelId = "";
    this.kernelStartPromise = (async () => {
      this.kernelId = await invoke("start_kernel", { specName: "python3" });
    })();

    this.store = createStore<NotebookStore>()(
      immer<NotebookStore>((set) => ({
        cellIds: [],
        cells: {},

        addCell: (cellId, initialText) =>
          set((state) => {
            state.cellIds.push(cellId);
            state.cells[cellId] = {
              initialText,
            };
          }),

        setOutput: (cellId, output) =>
          set((state) => {
            state.cells[cellId].output = output;
          }),
      })),
    );
    this.refs = new Map();
  }

  get state() {
    // Helper function, used internally to get the current notebook store state.
    return this.store.getState();
  }

  addCell(initialText: string): string {
    const cellId = Math.random().toString(36).slice(2);
    this.refs.set(cellId, {});
    this.store.getState().addCell(cellId, initialText);
    return cellId;
  }

  async execute(cellId: string) {
    if (!this.kernelId) {
      await this.kernelStartPromise;
    }

    const editor = this.refs.get(cellId)?.editor;
    if (!editor) {
      throw new Error(`Cell ${cellId} not found`);
    }
    const code = editor.state.doc.toString();
    try {
      const onEvent = new Channel<RunCellEvent>();
      let output = "";
      let displays: Record<string, any> = {};
      const update = () =>
        this.state.setOutput(cellId, {
          status: "success",
          output,
          displays,
        });
      update();

      onEvent.onmessage = (message: RunCellEvent) => {
        if (message.event === "stdout" || message.event === "stderr") {
          output += message.data;
          update();
        } else if (message.event === "execute_result") {
          // This means that there was a return value for the cell.
          output += message.data.data["text/plain"];
          update();
        } else if (message.event === "display_data") {
          const displayId = message.data.transient?.display_id || uuidv4();
          const html = displayDataToHtml(
            message.data.data,
            message.data.metadata,
          );
          if (html) {
            displays = { ...displays, [displayId]: html };
            update();
          } else {
            console.warn("Skipping unhandled display data", message.data);
          }
        } else if (message.event === "update_display_data") {
          const displayId = message.data.transient?.display_id;
          if (displayId && Object.hasOwn(displays, displayId)) {
            const html = displayDataToHtml(
              message.data.data,
              message.data.metadata,
            );
            if (html) {
              displays = { ...displays, [displayId]: html };
              update();
            } else {
              console.warn("Skipping unhandled display data", message.data);
            }
          } else {
            console.warn("Skipping display for bad display ID", message.data);
          }
        } else {
          console.warn("Skipping unhandled event", message);
        }
      };

      await invoke("run_cell", { kernelId: this.kernelId, code, onEvent });
      this.state.setOutput(cellId, { status: "success", output, displays });
    } catch (error: any) {
      this.state.setOutput(cellId, {
        status: "error",
        output: error,
        displays: {},
      });
    }
  }
}

/**
 * Returns the HTML form of a display data message.
 *
 * https://jupyter-client.readthedocs.io/en/stable/messaging.html#display-data
 */
function displayDataToHtml(
  data: Record<string, any>,
  metadata: Record<string, any>,
): string | null {
  for (const imageType of [
    "image/png",
    "image/jpeg",
    "image/svg+xml",
    "image/bmp",
    "image/gif",
  ]) {
    if (Object.hasOwn(data, imageType)) {
      const value = data[imageType];
      const alt = String(data["text/plain"] ?? "");
      const meta = metadata[imageType];
      if (typeof value === "string") {
        let image = `<img src="data:${imageType};base64,${encode(value)}" alt="${encode(alt)}"`;
        if (meta) {
          if (typeof meta.height === "number" && meta.height > 0) {
            image += ` height="${meta.height}"`;
          }
          if (typeof meta.width === "number" && meta.width > 0) {
            image += ` width="${meta.width}"`;
          }
        }
        image += " />";
        return image;
      }
    }
  }

  const value = data["text/plain"];
  if (typeof value === "string") {
    return `<pre>${encode(value)}</pre>`;
  }

  return null;
}

export const NotebookContext = createContext<Notebook | undefined>(undefined);

export function useNotebook(): Notebook {
  const notebook = useContext(NotebookContext);
  if (!notebook) {
    throw new Error("useNotebook must be used within a NotebookContext");
  }
  return notebook;
}
