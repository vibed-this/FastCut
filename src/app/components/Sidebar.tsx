/** 侧边栏：合集列表的展示与管理入口（搜索 + 按分类可折叠分组）。 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntdApp,
  AutoComplete,
  Button,
  Collapse,
  Divider,
  Dropdown,
  Empty,
  Input,
  List,
  Modal,
  Radio,
  Typography,
} from "antd";
import {
  BookOutlined,
  CloudOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  HolderOutlined,
  PlusOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  addCollection,
  getSidebarOrders,
  listCollections,
  pickFolder,
  readClipboardText,
  removeCollection,
  renameCollection,
  reorderCategories,
  reorderCollections,
  setCollectionCategory,
  setConfig,
} from "../api";
import type { Collection, CollectionKind } from "../api";
import { detectShareLink } from "../../../electron/shared/share-link";
import { useStore } from "../store";
import { OPEN_KEYS_KEY, loadOpenKeys } from "../uiMemory";

/** 新建合集弹窗内部的表单状态。 */
interface AddFormState {
  /** 合集类型。 */
  kind: CollectionKind;
  /** 云盘分享链接。 */
  url: string;
  /** 可选的提取密码。 */
  pwd: string;
  /** 小红书合集名。 */
  name: string;
  /** 合集分类（可选，空即未分类）。 */
  category: string;
}

/** 未分类分组的内部 key（分类名本身作其他分组 key，空分类用此占位）。 */
const UNCATEGORIZED_KEY = "__uncategorized__";
/** 未分类分组的展示标题。 */
const UNCATEGORIZED_TITLE = "未分类";

/** 取合集的归一化分类名（去空白，空即 ""）。 */
function categoryOf(c: Collection): string {
  return (c.category ?? "").trim();
}

/** 分组 key → 后端排序键（未分类哨兵 ""）。 */
function toOrderKey(groupKey: string): string {
  return groupKey === UNCATEGORIZED_KEY ? "" : groupKey;
}

/**
 * 透传 dnd-kit 的 pointer 激活：手柄为阻断冒泡（防折叠/点开）自带了 onPointerDown，
 * 会覆盖 useSortable 的 listeners.onPointerDown，不手动调用则鼠标拖拽永远无法启动。
 */
function forwardPointerDown(
  listeners: Record<string, unknown> | undefined,
  e: React.PointerEvent,
): void {
  const fn = listeners?.["onPointerDown"] as unknown as
    | ((e: React.PointerEvent) => void)
    | undefined;
  fn?.(e);
}

/** 分类头（含拖拽手柄）：listeners 只绑手柄，避免与折叠点击冲突。 */
function CategoryLabel(props: {
  groupKey: string;
  title: string;
  count: number;
  disabled: boolean;
}): React.JSX.Element {
  const { groupKey, title, count, disabled } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: groupKey,
    data: { type: "category" },
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
      }}
    >
      <span
        data-testid="category-drag-handle"
        {...(disabled ? {} : attributes)}
        {...(disabled ? {} : listeners)}
        onClick={(e) => {
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (!disabled) {
            forwardPointerDown(listeners as unknown as Record<string, unknown> | undefined, e);
          }
        }}
        title={disabled ? "搜索时不可拖拽排序" : "拖拽排序分类"}
        style={{
          cursor: disabled ? "not-allowed" : "grab",
          color: "#bfbfbf",
          display: "inline-flex",
          touchAction: "none",
        }}
      >
        <HolderOutlined />
      </span>
      <Typography.Text
        data-testid="collection-category-header"
        strong
        ellipsis
        style={{ maxWidth: 160 }}
        title={title}
      >
        {title}（{count}）
      </Typography.Text>
    </div>
  );
}

/** 合集行（含行首拖拽手柄）：整行仍可点击打开。 */
function SortableCollectionRow(props: {
  collection: Collection;
  backendCategory: string;
  active: boolean;
  disabled: boolean;
  onOpen: (c: Collection) => void;
  moreMenu: (c: Collection) => React.JSX.Element;
}): React.JSX.Element {
  const { collection, backendCategory, active, disabled, onOpen, moreMenu } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: collection.collection_id,
    data: { type: "collection", category: backendCategory },
    disabled,
  });
  const icon =
    collection.kind === "xiaohongshu" ? (
      <BookOutlined style={{ color: "#fa541c" }} />
    ) : (
      <CloudOutlined style={{ color: "#1677ff" }} />
    );
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
        width: "100%",
      }}
    >
      <List.Item
        className="collection-list-item"
        style={{
          background: active ? "#e6f4ff" : undefined,
          borderRadius: 8,
          padding: "8px 10px",
          cursor: "pointer",
          border: "none",
          width: "100%",
        }}
        onClick={() => {
          onOpen(collection);
        }}
        actions={[moreMenu(collection)]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
          <span
            data-testid="collection-drag-handle"
            {...(disabled ? {} : attributes)}
            {...(disabled ? {} : listeners)}
            onClick={(e) => {
              e.stopPropagation();
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (!disabled) {
                forwardPointerDown(listeners as unknown as Record<string, unknown> | undefined, e);
              }
            }}
            title={disabled ? "搜索时不可拖拽排序" : "拖拽排序"}
            style={{
              cursor: disabled ? "not-allowed" : "grab",
              color: "#bfbfbf",
              display: "inline-flex",
              alignItems: "center",
              lineHeight: 1,
              touchAction: "none",
              flexShrink: 0,
            }}
          >
            <HolderOutlined />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span
                style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, lineHeight: 1 }}
              >
                {icon}
              </span>
              <Typography.Text
                data-testid="collection-item"
                id={active ? "active-collection-item" : undefined}
                ellipsis
                style={{ flex: 1, minWidth: 0 }}
                title={collection.name}
              >
                {collection.name}
              </Typography.Text>
            </div>
          </div>
        </div>
      </List.Item>
    </div>
  );
}

/** 侧边栏组件属性。 */
export interface SidebarProps {
  /** 预留扩展，无必填项。 */
  className?: string;
}

/**
 * 合集列表侧边栏。
 *
 * @param props - 组件属性
 * @returns 侧边栏元素
 */
export default function Sidebar(props: SidebarProps): React.JSX.Element {
  const { className } = props;
  const { state, dispatch } = useStore();
  const { message, modal } = AntdApp.useApp();
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>({
    kind: "alipan",
    url: "",
    pwd: "",
    name: "",
    category: "",
  });
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  /** 新建弹窗表单是否仍是打开时的初始值（剪贴板自动填入只动 pristine 表单，不覆盖用户输入）。 */
  const addPristineRef = useRef(true);
  /** 顶部搜索框：按合集名称过滤（大小写不敏感）。 */
  const [query, setQuery] = useState("");
  /** 展开中的分組 key：null 即全部展开（初始态）；搜索时强制全展；变更即记入 localStorage。 */
  const [openKeys, setOpenKeys] = useState<string[] | null>(() =>
    typeof localStorage === "undefined" ? null : loadOpenKeys(() => localStorage.getItem(OPEN_KEYS_KEY)),
  );
  useEffect(() => {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      if (openKeys === null) {
        localStorage.removeItem(OPEN_KEYS_KEY);
      } else {
        localStorage.setItem(OPEN_KEYS_KEY, JSON.stringify(openKeys));
      }
    } catch {
      // 存储不可用时忽略，下次回默认全展。
    }
  }, [openKeys]);

  /**
   * 打开变化时定位选中行：所在分组折叠就先展开（下一轮再滚），
   * 否则若已完全可见就不动，不可见才居中。只认 id 变化，
   * 用户平时折叠/滚动浏览时不会被拽回。
   */
  const scrolledForRef = useRef<string | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const id = state.activeCollectionId;
    if (id === null || scrolledForRef.current === id) {
      return;
    }
    const hit = state.collections.find((c) => c.collection_id === id);
    if (hit === undefined) {
      return;
    }
    const cat = categoryOf(hit);
    const key = cat === "" ? UNCATEGORIZED_KEY : cat;
    if (openKeys !== null && !openKeys.includes(key)) {
      setOpenKeys([...openKeys, key]);
      return;
    }
    const t = requestAnimationFrame(() => {
      const el = document.getElementById("active-collection-item");
      if (el === null) {
        return;
      }
      const container = listScrollRef.current;
      if (container !== null) {
        const r = el.getBoundingClientRect();
        const c = container.getBoundingClientRect();
        if (r.top >= c.top && r.bottom <= c.bottom) {
          return;
        }
      }
      el.scrollIntoView({ block: "center" });
    });
    scrolledForRef.current = id;
    return () => cancelAnimationFrame(t);
  }, [state.activeCollectionId, state.collections, openKeys]);

  /** 打开新建合集弹窗：重置表单后读剪贴板，命中分享链接自动填入。 */
  function handleOpenAdd(): void {
    setAddForm({ kind: "alipan", url: "", pwd: "", name: "", category: "" });
    setAddError("");
    addPristineRef.current = true;
    setAddOpen(true);
    void readClipboardText().then((text) => {
      const hit = detectShareLink(text);
      if (hit === null || !addPristineRef.current) {
        return;
      }
      addPristineRef.current = false;
      if (hit.kind === "alipan") {
        setAddForm({ kind: "alipan", url: hit.url, pwd: hit.pwd ?? "", name: "", category: "" });
      } else {
        // 小红书新建只需合集名：切到对应页，链接后续在导入弹窗自动填入
        setAddForm({ kind: "xiaohongshu", url: "", pwd: "", name: "", category: "" });
      }
    });
  }
  const [renameTarget, setRenameTarget] = useState<Collection | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);
  /** 设置分类弹窗的目标合集与输入值（空即移出分类）。 */
  const [categoryTarget, setCategoryTarget] = useState<Collection | null>(null);
  const [categoryValue, setCategoryValue] = useState("");
  const [categoryLoading, setCategoryLoading] = useState(false);

  /** 点击条目打开合集（单视图，直接切换）。 */
  function handleOpen(collection: Collection): void {
    if (state.activeCollectionId === collection.collection_id) {
      return;
    }
    dispatch({ type: "explorer/open", collection });
  }

  /** 提交新建合集。 */
  async function handleAddConfirm(): Promise<void> {
    setAddError("");
    setAddLoading(true);
    try {
      const category = addForm.category.trim() === "" ? undefined : addForm.category.trim();
      if (addForm.kind === "alipan") {
        const url = addForm.url.trim();
        if (url === "") {
          setAddError("请输入分享链接");
          return;
        }
        const pwd = addForm.pwd.trim() === "" ? undefined : addForm.pwd.trim();
        const created = await addCollection("alipan", { url, pwd, category });
        dispatch({ type: "collections/add", collection: created });
        dispatch({ type: "explorer/open", collection: created });
      } else {
        const name = addForm.name.trim();
        if (name === "") {
          setAddError("请输入合集名");
          return;
        }
        const created = await addCollection("xiaohongshu", { name, category });
        dispatch({ type: "collections/add", collection: created });
        dispatch({ type: "explorer/open", collection: created });
      }
      setAddOpen(false);
      setAddForm({ kind: "alipan", url: "", pwd: "", name: "", category: "" });
    } catch (e) {
      // 行内报错，不抛全局
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddLoading(false);
    }
  }

  /** 提交重命名。 */
  async function handleRenameConfirm(): Promise<void> {
    if (renameTarget === null) {
      return;
    }
    const name = renameName.trim();
    if (name === "") {
      void message.warning("请输入新的合集名称");
      return;
    }
    setRenameLoading(true);
    try {
      const renamed = await renameCollection(renameTarget.collection_id, name);
      dispatch({
        type: "collections/rename",
        collection_id: renameTarget.collection_id,
        name,
      });
      // 小红书重命名会重命名磁盘文件夹（relDir 变化）：若正打开该合集，同步刷新整条栈路径。
      if (
        renamed.kind === "xiaohongshu" &&
        state.explorer !== null &&
        state.explorer.collection_id === renameTarget.collection_id &&
        renamed.relDir !== undefined &&
        renamed.relDir !== ""
      ) {
        const stack = state.explorer.stack;
        const oldRoot = stack[0]?.file_id ?? "";
        if (oldRoot !== "" && oldRoot !== renamed.relDir) {
          dispatch({
            type: "explorer/navigate",
            stack: stack.map((s) =>
              s.file_id === oldRoot
                ? { ...s, file_id: renamed.relDir as string }
                : s.file_id.startsWith(`${oldRoot}/`)
                  ? { ...s, file_id: `${renamed.relDir as string}${s.file_id.slice(oldRoot.length)}` }
                  : s,
            ),
          });
        }
      }
      setRenameTarget(null);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameLoading(false);
    }
  }

  /** 提交设置分类（空即移出分类）。 */
  async function handleCategoryConfirm(): Promise<void> {
    if (categoryTarget === null) {
      return;
    }
    setCategoryLoading(true);
    try {
      const category = categoryValue.trim() === "" ? undefined : categoryValue.trim();
      await setCollectionCategory(categoryTarget.collection_id, category);
      dispatch({
        type: "collections/category",
        collection_id: categoryTarget.collection_id,
        category,
      });
      setCategoryTarget(null);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCategoryLoading(false);
    }
  }

  /** 确认删除合集（收纳在更多菜单内，二次确认）。 */
  function confirmRemove(collection: Collection): void {
    const isXhs = collection.kind === "xiaohongshu";
    modal.confirm({
      title: isXhs ? "确定删除该合集吗？将连带删除磁盘文件夹" : "确定删除该合集吗？",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => {
        void handleRemove(collection);
      },
    });
  }

  /** 执行删除合集。 */
  async function handleRemove(collection: Collection): Promise<void> {
    try {
      await removeCollection(collection.collection_id);
      dispatch({
        type: "collections/remove",
        collection_id: collection.collection_id,
      });
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    }
  }

  /** 选择素材文件夹。 */
  async function handlePickFolder(): Promise<void> {
    try {
      const picked = await pickFolder();
      if (picked === null || picked === "") {
        return;
      }
      await setConfig({ target_dir: picked });
      dispatch({ type: "material/set", dir: picked });
      void message.success("素材文件夹已更新");
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    }
  }

  const emptyMaterial = state.materialDir === "";

  /** 已存在的分类（去重排序，供新建/设置时联想）。 */
  const existingCategories = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const c of state.collections) {
      const name = categoryOf(c);
      if (name !== "") {
        set.add(name);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [state.collections]);

  /** 搜索过滤后的合集（仅按名称，大小写不敏感）。 */
  const filtered = useMemo<Collection[]>(() => {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return state.collections;
    }
    return state.collections.filter((c) => c.name.toLowerCase().includes(q));
  }, [state.collections, query]);

  /** 按分类分组：有 categoryOrder 时按序排，未知追加尾部按字母序；无序回退字母序+未分类沉底。组内按 collectionOrders 排，未知按 added_at 追加。 */
  const groups = useMemo<{ key: string; title: string; items: Collection[] }[]>(() => {
    const byCategory = new Map<string, Collection[]>();
    const uncategorized: Collection[] = [];
    for (const c of filtered) {
      const name = categoryOf(c);
      if (name === "") {
        uncategorized.push(c);
      } else {
        const arr = byCategory.get(name);
        if (arr === undefined) {
          byCategory.set(name, [c]);
        } else {
          arr.push(c);
        }
      }
    }
    function sortItems(items: Collection[], orderKey: string): Collection[] {
      const order = state.collectionOrders[orderKey];
      if (order === undefined || order.length === 0) {
        return [...items].sort((a, b) => a.added_at - b.added_at);
      }
      const idx = new Map(order.map((id, i) => [id, i] as const));
      return [...items].sort((a, b) => {
        const ia = idx.get(a.collection_id);
        const ib = idx.get(b.collection_id);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        return a.added_at - b.added_at;
      });
    }
    const categorized = [...byCategory.entries()].map(([title, items]) => ({
      key: title,
      title,
      items: sortItems(items, title),
    }));
    const unc =
      uncategorized.length > 0
        ? { key: UNCATEGORIZED_KEY, title: UNCATEGORIZED_TITLE, items: sortItems(uncategorized, "") }
        : null;
    const order = state.categoryOrder;
    if (order.length === 0) {
      categorized.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
      const out = [...categorized];
      if (unc !== null) out.push(unc);
      return out;
    }
    const orderIdx = new Map(order.map((k, i) => [k, i] as const));
    const all = unc !== null ? [...categorized, unc] : [...categorized];
    all.sort((a, b) => {
      const ka = toOrderKey(a.key);
      const kb = toOrderKey(b.key);
      const ia = orderIdx.get(ka);
      const ib = orderIdx.get(kb);
      if (ia !== undefined && ib !== undefined) return ia - ib;
      if (ia !== undefined) return -1;
      if (ib !== undefined) return 1;
      if (ka === "" && kb !== "") return 1;
      if (kb === "" && ka !== "") return -1;
      return a.title.localeCompare(b.title, "zh-Hans-CN");
    });
    return all;
  }, [filtered, state.categoryOrder, state.collectionOrders]);

  const groupKeys = useMemo(() => groups.map((g) => g.key), [groups]);
  const searching = query.trim() !== "";
  // 搜索时强制全展；平时 null 即全展，用户折叠后走受控值。
  const activeKey = searching ? groupKeys : (openKeys ?? groupKeys);
  const dragDisabled = searching;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** 失败回滚：重拉合集 + 排序快照。 */
  async function refreshOrdersRollback(): Promise<void> {
    try {
      const [collections, orders] = await Promise.all([
        listCollections(),
        getSidebarOrders().catch(() => null),
      ]);
      dispatch({ type: "collections/set", collections });
      if (orders !== null) {
        dispatch({
          type: "sidebar/orders",
          category_order: orders.category_order,
          collection_orders: orders.collection_orders,
        });
      }
    } catch {
      // 回滚拉取本身失败时保持本地乐观态，避免二次报错刷屏。
    }
  }

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    if (dragDisabled) return;
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const activeType = (active.data.current as { type?: string } | undefined)?.type;
    const overType = (over.data.current as { type?: string } | undefined)?.type;
    if (activeType === "category") {
      if (overType !== "category") return;
      const ids = groups.map((g) => g.key);
      const oldIdx = ids.indexOf(String(active.id));
      const newIdx = ids.indexOf(String(over.id));
      if (oldIdx < 0 || newIdx < 0) return;
      const orderedKeys = arrayMove(ids, oldIdx, newIdx).map(toOrderKey);
      dispatch({ type: "categories/reorder", orderedKeys });
      try {
        const canonical = await reorderCategories(orderedKeys);
        dispatch({ type: "categories/reorder", orderedKeys: canonical });
      } catch (e) {
        void message.error(e instanceof Error ? e.message : String(e));
        void refreshOrdersRollback();
      }
      return;
    }
    if (activeType === "collection") {
      if (overType !== "collection") return;
      const category = String(
        (active.data.current as { category?: string } | undefined)?.category ?? "",
      );
      const overCategory = String(
        (over.data.current as { category?: string } | undefined)?.category ?? "",
      );
      if (overCategory !== category) return;
      const group = groups.find((g) => toOrderKey(g.key) === category);
      if (group === undefined) return;
      const orderedIds = group.items.map((c) => c.collection_id);
      const oldIdx = orderedIds.indexOf(String(active.id));
      const newIdx = orderedIds.indexOf(String(over.id));
      if (oldIdx < 0 || newIdx < 0) return;
      const next = arrayMove(orderedIds, oldIdx, newIdx);
      dispatch({ type: "collections/reorder", category, orderedIds: next });
      try {
        await reorderCollections(category, next);
      } catch (e) {
        void message.error(e instanceof Error ? e.message : String(e));
        void refreshOrdersRollback();
      }
    }
  }

  function renderMoreMenu(collection: Collection): React.JSX.Element {
    return (
      <Dropdown
        key="more"
        trigger={["click"]}
        menu={{
          items: [
            {
              key: "rename",
              label: "重命名",
              onClick: () => {
                setRenameTarget(collection);
                setRenameName(collection.name);
              },
            },
            {
              key: "category",
              label: "设置分类",
              onClick: () => {
                setCategoryTarget(collection);
                setCategoryValue(categoryOf(collection));
              },
            },
            {
              key: "remove",
              label: "删除",
              danger: true,
              icon: <DeleteOutlined />,
              onClick: () => {
                confirmRemove(collection);
              },
            },
          ],
        }}
      >
        <Button
          type="text"
          size="small"
          icon={<EllipsisOutlined />}
          aria-label="更多操作"
          onClick={(e) => {
            e.stopPropagation();
          }}
        />
      </Dropdown>
    );
  }

  function renderRow(collection: Collection, backendCategory: string): React.JSX.Element {
    const active = state.activeCollectionId === collection.collection_id;
    return (
      <SortableCollectionRow
        collection={collection}
        backendCategory={backendCategory}
        active={active}
        disabled={dragDisabled}
        onOpen={handleOpen}
        moreMenu={renderMoreMenu}
      />
    );
  }

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <style>{`.ant-list .ant-list-item.collection-list-item .ant-list-item-action{opacity:0;pointer-events:none;transition:opacity .15s;margin-inline-start:8px}
.ant-list .ant-list-item.collection-list-item:hover .ant-list-item-action,.ant-list .ant-list-item.collection-list-item:focus-within .ant-list-item-action{opacity:1;pointer-events:auto}`}</style>
      <div style={{ padding: "12px 12px 0", display: "flex", gap: 8, alignItems: "center" }}>
        <Input
          data-testid="collection-search-input"
          placeholder="搜索集合名称"
          allowClear
          prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button
          data-testid="add-collection-btn"
          type="primary"
          icon={<PlusOutlined />}
          aria-label="新建合集"
          title="新建合集"
          onClick={() => {
            handleOpenAdd();
          }}
        />
      </div>
      <div ref={listScrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 8px 12px" }}>
        {state.collections.length === 0 ? (
          <Empty description="暂无合集，请先新建" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : filtered.length === 0 ? (
          <Empty description="无匹配的合集" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <DndContext
            sensors={sensors}
            onDragEnd={(e) => {
              void handleDragEnd(e);
            }}
          >
            <SortableContext items={groupKeys} strategy={verticalListSortingStrategy}>
              <Collapse
                data-testid="collection-category-collapse"
                ghost
                size="small"
                activeKey={activeKey}
                onChange={(keys) => {
                  setOpenKeys(Array.isArray(keys) ? [...keys] : [keys]);
                }}
                items={groups.map((g) => ({
                  key: g.key,
                  label: (
                    <CategoryLabel
                      groupKey={g.key}
                      title={g.title}
                      count={g.items.length}
                      disabled={dragDisabled}
                    />
                  ),
                  children: (
                    <SortableContext
                      items={g.items.map((c) => c.collection_id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <List
                        dataSource={g.items}
                        locale={{ emptyText: " " }}
                        renderItem={(c) => renderRow(c, toOrderKey(g.key))}
                      />
                    </SortableContext>
                  ),
                }))}
              />
            </SortableContext>
          </DndContext>
        )}
      </div>
      <Divider style={{ margin: "4px 0 0" }} />
      <div style={{ padding: "8px 12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        <Typography.Text strong>设置</Typography.Text>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            素材文件夹
          </Typography.Text>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <Typography.Text
              data-testid="settings-material-dir"
              ellipsis
              style={{ flex: 1, minWidth: 0, fontSize: 12 }}
              title={state.materialDir ?? ""}
            >
              {emptyMaterial ? "未配置" : (state.materialDir ?? "")}
            </Typography.Text>
            <Button
              data-testid="settings-pick-btn"
              size="small"
              onClick={() => {
                void handlePickFolder();
              }}
            >
              选择
            </Button>
          </div>
        </div>
      </div>
      <Modal
        title="新建合集"
        open={addOpen}
        confirmLoading={addLoading}
        okText="新建"
        cancelText="取消"
        okButtonProps={{ "data-testid": "add-collection-confirm" }}
        onOk={() => {
          void handleAddConfirm();
        }}
        onCancel={() => {
          setAddOpen(false);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Radio.Group
            data-testid="collection-kind-radio"
            value={addForm.kind}
            onChange={(e) => {
              addPristineRef.current = false;
              setAddForm((s) => ({ ...s, kind: e.target.value as CollectionKind }));
              setAddError("");
            }}
          >
            <Radio.Button value="alipan">阿里云盘分享</Radio.Button>
            <Radio.Button value="xiaohongshu">小红书合集</Radio.Button>
          </Radio.Group>
          {addForm.kind === "alipan" ? (
            <>
              <div>
                <div style={{ marginBottom: 6 }}>分享链接</div>
                <Input
                  data-testid="collection-url-input"
                  placeholder="https://www.alipan.com/s/xxxx"
                  value={addForm.url}
                  onChange={(e) => {
                    addPristineRef.current = false;
                    setAddForm((s) => ({ ...s, url: e.target.value }));
                  }}
                />
              </div>
              <div>
                <div style={{ marginBottom: 6 }}>提取密码（可选）</div>
                <Input
                  data-testid="collection-pwd-input"
                  placeholder="无密码可不填"
                  value={addForm.pwd}
                  onChange={(e) => {
                    addPristineRef.current = false;
                    setAddForm((s) => ({ ...s, pwd: e.target.value }));
                  }}
                />
              </div>
            </>
          ) : (
            <div>
              <div style={{ marginBottom: 6 }}>合集名（将在素材文件夹下创建同名目录）</div>
              <Input
                data-testid="collection-name-input"
                placeholder="例如：美食探店第1期"
                value={addForm.name}
                onChange={(e) => {
                  addPristineRef.current = false;
                  setAddForm((s) => ({ ...s, name: e.target.value }));
                }}
              />
            </div>
          )}
          <div>
            <div style={{ marginBottom: 6 }}>分类（可选，空即未分类）</div>
            <AutoComplete
              style={{ width: "100%" }}
              options={existingCategories.map((c) => ({ value: c }))}
              value={addForm.category}
              onChange={(v) => {
                addPristineRef.current = false;
                setAddForm((s) => ({ ...s, category: v }));
              }}
            >
              <Input
                data-testid="add-collection-category-input"
                placeholder="例如：学习、素材"
                maxLength={32}
              />
            </AutoComplete>
          </div>
          {addError !== "" ? <Typography.Text type="danger">{addError}</Typography.Text> : null}
        </div>
      </Modal>
      <Modal
        title="重命名合集"
        open={renameTarget !== null}
        confirmLoading={renameLoading}
        okText="保存"
        cancelText="取消"
        onOk={() => {
          void handleRenameConfirm();
        }}
        onCancel={() => {
          setRenameTarget(null);
        }}
      >
        <Input
          placeholder="请输入新的合集名称"
          value={renameName}
          onChange={(e) => {
            setRenameName(e.target.value);
          }}
        />
      </Modal>
      <Modal
        title={`设置分类${categoryTarget !== null ? `：${categoryTarget.name}` : ""}`}
        open={categoryTarget !== null}
        confirmLoading={categoryLoading}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ "data-testid": "set-category-confirm" }}
        onOk={() => {
          void handleCategoryConfirm();
        }}
        onCancel={() => {
          setCategoryTarget(null);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <AutoComplete
            style={{ width: "100%" }}
            options={existingCategories.map((c) => ({ value: c }))}
            value={categoryValue}
            onChange={(v) => {
              setCategoryValue(v);
            }}
          >
            <Input
              data-testid="set-category-input"
              placeholder="输入分类名，留空即移出分类"
              maxLength={32}
            />
          </AutoComplete>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            分类可为空；输入新名称即新建分类。
          </Typography.Text>
        </div>
      </Modal>
    </div>
  );
}
