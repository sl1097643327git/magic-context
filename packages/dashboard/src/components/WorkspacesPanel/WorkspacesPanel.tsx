import { createResource, createSignal, Index, Show } from "solid-js";
import {
  addWorkspaceMember,
  createWorkspace,
  deleteWorkspace,
  enumerateMemoryProjects,
  listWorkspaces,
  removeWorkspaceMember,
  renameWorkspace,
  setMemberDisplayName,
  workspaceSchemaReady,
} from "../../lib/api";
import type { ProjectRow, WorkspaceListItem } from "../../lib/types";
import FilterSelect from "../shared/FilterSelect";

export default function WorkspacesPanel() {
  const [ready] = createResource(workspaceSchemaReady);
  const [workspaces, { refetch }] = createResource(listWorkspaces);
  const [projects] = createResource(enumerateMemoryProjects);
  const [error, setError] = createSignal<string | null>(null);
  const [newName, setNewName] = createSignal("");
  const [renameId, setRenameId] = createSignal<number | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [addMemberWsId, setAddMemberWsId] = createSignal<number | null>(null);
  const [addMemberProject, setAddMemberProject] = createSignal("");
  const [addMemberDisplayName, setAddMemberDisplayName] = createSignal("");
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<number | null>(null);
  const [confirmRemoveKey, setConfirmRemoveKey] = createSignal<string | null>(null);
  const [editingDisplayKey, setEditingDisplayKey] = createSignal<string | null>(null);
  const [editingDisplayValue, setEditingDisplayValue] = createSignal("");
  let confirmDeleteTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmRemoveTimer: ReturnType<typeof setTimeout> | undefined;

  const twoClickDelete = (id: number, perform: () => void) => {
    if (confirmDeleteId() !== id) {
      setConfirmDeleteId(id);
      if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
      confirmDeleteTimer = setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    setConfirmDeleteId(null);
    perform();
  };

  const twoClickRemove = (key: string, perform: () => void) => {
    if (confirmRemoveKey() !== key) {
      setConfirmRemoveKey(key);
      if (confirmRemoveTimer) clearTimeout(confirmRemoveTimer);
      confirmRemoveTimer = setTimeout(() => setConfirmRemoveKey(null), 3000);
      return;
    }
    if (confirmRemoveTimer) clearTimeout(confirmRemoveTimer);
    setConfirmRemoveKey(null);
    perform();
  };

  const handleCreate = async () => {
    const name = newName().trim();
    if (!name) return;
    try {
      setError(null);
      await createWorkspace(name);
      setNewName("");
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRename = async (id: number) => {
    const name = renameValue().trim();
    if (!name) return;
    try {
      setError(null);
      await renameWorkspace(id, name);
      setRenameId(null);
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setError(null);
      await deleteWorkspace(id);
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const memberProjectsForWorkspace = (ws: WorkspaceListItem): ProjectRow[] => {
    const memberIds = new Set(ws.members.map((m) => m.project_path));
    return (projects() ?? []).filter((p) => !memberIds.has(p.identity));
  };

  const handleAddMember = async (workspaceId: number) => {
    const identity = addMemberProject();
    if (!identity) return;
    const row = (projects() ?? []).find((p) => p.identity === identity);
    if (!row) return;
    const displayName = addMemberDisplayName().trim() || row.display_name;
    try {
      setError(null);
      await addWorkspaceMember(workspaceId, row.identity, displayName, row.primary_path);
      setAddMemberWsId(null);
      setAddMemberProject("");
      setAddMemberDisplayName("");
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemoveMember = async (workspaceId: number, projectPath: string) => {
    try {
      setError(null);
      await removeWorkspaceMember(workspaceId, projectPath);
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSaveDisplayName = async (workspaceId: number, projectPath: string) => {
    const name = editingDisplayValue().trim();
    if (!name) {
      setError("Display name cannot be empty.");
      return;
    }
    try {
      setError(null);
      await setMemberDisplayName(workspaceId, projectPath, name);
      setEditingDisplayKey(null);
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <Show when={error()}>
        <div style={{ padding: "8px 20px" }}>
          <div
            style={{
              background: "var(--error-bg, #3a1c1c)",
              border: "1px solid var(--error-border, #6b2c2c)",
              "border-radius": "var(--radius-md)",
              padding: "8px 12px",
              "font-size": "12px",
              color: "var(--error-text, #ef4444)",
            }}
          >
            {error()}
            <button
              type="button"
              class="btn sm"
              style={{ "margin-left": "8px" }}
              onClick={() => setError(null)}
            >
              ✕
            </button>
          </div>
        </div>
      </Show>

      <div class="section-header">
        <h1 class="section-title">Workspaces</h1>
      </div>

      <div class="scroll-area">
        <Show when={!ready.loading && ready() === false}>
          <div class="empty-state" style={{ "max-width": "480px", margin: "40px auto" }}>
            <span class="empty-state-icon">🗂️</span>
            <p style={{ "margin-top": "12px", "line-height": "1.5" }}>
              Update the Magic Context plugin and start a session to enable workspaces.
            </p>
          </div>
        </Show>

        <Show when={ready() === true}>
          <div style={{ padding: "0 0 16px", display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
            <input
              class="search-input"
              type="text"
              placeholder="New workspace name"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              style={{ "max-width": "240px" }}
            />
            <button type="button" class="btn primary sm" onClick={handleCreate}>
              Create
            </button>
          </div>

          <Show when={workspaces.loading}>
            <div class="empty-state">Loading workspaces...</div>
          </Show>

          <Show when={!workspaces.loading && (workspaces() ?? []).length === 0}>
            <div class="empty-state">
              <span class="empty-state-icon">🗂️</span>
              <span>No workspaces yet — create one to pool memories across projects.</span>
            </div>
          </Show>

          <div class="list-gap">
            <Index each={workspaces() ?? []}>
              {(ws) => {
                const item = () => ws() as WorkspaceListItem;
                const removeKey = (projectPath: string) => `${item().id}:${projectPath}`;
                return (
                  <div class="card" style={{ padding: "12px 14px" }}>
                    <div
                      style={{
                        display: "flex",
                        "justify-content": "space-between",
                        "align-items": "center",
                        gap: "8px",
                        "flex-wrap": "wrap",
                      }}
                    >
                      <Show
                        when={renameId() === item().id}
                        fallback={<strong style={{ "font-size": "15px" }}>{item().name}</strong>}
                      >
                        <input
                          class="search-input"
                          value={renameValue()}
                          onInput={(e) => setRenameValue(e.currentTarget.value)}
                          style={{ "max-width": "200px" }}
                        />
                        <button
                          type="button"
                          class="btn sm primary"
                          onClick={() => handleRename(item().id)}
                        >
                          Save
                        </button>
                        <button type="button" class="btn sm" onClick={() => setRenameId(null)}>
                          Cancel
                        </button>
                      </Show>
                      <Show when={renameId() !== item().id}>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            type="button"
                            class="btn sm"
                            onClick={() => {
                              setRenameId(item().id);
                              setRenameValue(item().name);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            class="btn sm danger"
                            onClick={() => twoClickDelete(item().id, () => handleDelete(item().id))}
                          >
                            {confirmDeleteId() === item().id ? "Click again to confirm" : "Delete"}
                          </button>
                        </div>
                      </Show>
                    </div>

                    <div style={{ "margin-top": "12px" }}>
                      <div class="category-header" style={{ "margin-bottom": "8px" }}>
                        Members <span class="category-count">({item().members.length})</span>
                      </div>
                      <Index each={item().members}>
                        {(member) => {
                          const m = () => member();
                          const key = () => removeKey(m().project_path);
                          return (
                            <div
                              class="card"
                              style={{
                                padding: "8px 10px",
                                "margin-bottom": "6px",
                                display: "flex",
                                "align-items": "center",
                                gap: "8px",
                                "flex-wrap": "wrap",
                              }}
                            >
                              <Show
                                when={editingDisplayKey() === key()}
                                fallback={
                                  <>
                                    <span class="pill blue">{m().display_name}</span>
                                    <span
                                      style={{ color: "var(--text-muted)", "font-size": "12px" }}
                                    >
                                      {m().memory_count} memories · {m().display_path}
                                    </span>
                                    <button
                                      type="button"
                                      class="btn sm ghost"
                                      onClick={() => {
                                        setEditingDisplayKey(key());
                                        setEditingDisplayValue(m().display_name);
                                      }}
                                    >
                                      Edit name
                                    </button>
                                  </>
                                }
                              >
                                <input
                                  class="search-input"
                                  value={editingDisplayValue()}
                                  onInput={(e) => setEditingDisplayValue(e.currentTarget.value)}
                                  style={{ "max-width": "140px" }}
                                />
                                <button
                                  type="button"
                                  class="btn sm"
                                  onClick={() => handleSaveDisplayName(item().id, m().project_path)}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  class="btn sm"
                                  onClick={() => setEditingDisplayKey(null)}
                                >
                                  Cancel
                                </button>
                              </Show>
                              <button
                                type="button"
                                class="btn sm danger"
                                style={{ "margin-left": "auto" }}
                                onClick={() =>
                                  twoClickRemove(key(), () =>
                                    handleRemoveMember(item().id, m().project_path),
                                  )
                                }
                              >
                                {confirmRemoveKey() === key() ? "Confirm remove" : "Remove"}
                              </button>
                            </div>
                          );
                        }}
                      </Index>

                      <Show when={addMemberWsId() === item().id}>
                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            "flex-wrap": "wrap",
                            "align-items": "center",
                            "margin-top": "8px",
                          }}
                        >
                          <FilterSelect
                            value={addMemberProject()}
                            onChange={setAddMemberProject}
                            placeholder="Select project"
                            align="left"
                            options={[
                              { value: "", label: "Select project" },
                              ...memberProjectsForWorkspace(item()).map((p) => ({
                                value: p.identity,
                                label: p.display_name,
                              })),
                            ]}
                          />
                          <input
                            class="search-input"
                            placeholder="Display name (optional)"
                            value={addMemberDisplayName()}
                            onInput={(e) => setAddMemberDisplayName(e.currentTarget.value)}
                            style={{ "max-width": "160px" }}
                          />
                          <button
                            type="button"
                            class="btn sm primary"
                            onClick={() => handleAddMember(item().id)}
                          >
                            Add
                          </button>
                          <button
                            type="button"
                            class="btn sm"
                            onClick={() => {
                              setAddMemberWsId(null);
                              setAddMemberProject("");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </Show>
                      <Show when={addMemberWsId() !== item().id}>
                        <button
                          type="button"
                          class="btn sm"
                          style={{ "margin-top": "8px" }}
                          onClick={() => setAddMemberWsId(item().id)}
                        >
                          + Add member
                        </button>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </Index>
          </div>
        </Show>
      </div>
    </>
  );
}
