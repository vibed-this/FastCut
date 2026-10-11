/** 侧边栏：合集列表的展示与管理入口。 */
import { useRef, useState } from "react";
import {
  App as AntdApp,
  Button,
  Divider,
  Dropdown,
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
  PlusOutlined,
} from "@ant-design/icons";
import { addCollection, pickFolder, readClipboardText, removeCollection, renameCollection, setConfig } from "../api";
import type { Collection, CollectionKind } from "../api";
import { detectShareLink } from "../../../electron/shared/share-link";
import { useStore } from "../store";

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
  });
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  /** 新建弹窗表单是否仍是打开时的初始值（剪贴板自动填入只动 pristine 表单，不覆盖用户输入）。 */
  const addPristineRef = useRef(true);

  /** 打开新建合集弹窗：重置表单后读剪贴板，命中分享链接自动填入。 */
  function handleOpenAdd(): void {
    setAddForm({ kind: "alipan", url: "", pwd: "", name: "" });
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
        setAddForm({ kind: "alipan", url: hit.url, pwd: hit.pwd ?? "", name: "" });
      } else {
        // 小红书新建只需合集名：切到对应页，链接后续在导入弹窗自动填入
        setAddForm({ kind: "xiaohongshu", url: "", pwd: "", name: "" });
      }
    });
  }
  const [renameTarget, setRenameTarget] = useState<Collection | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);

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
      if (addForm.kind === "alipan") {
        const url = addForm.url.trim();
        if (url === "") {
          setAddError("请输入分享链接");
          return;
        }
        const pwd = addForm.pwd.trim() === "" ? undefined : addForm.pwd.trim();
        const created = await addCollection("alipan", { url, pwd });
        dispatch({ type: "collections/add", collection: created });
        dispatch({ type: "explorer/open", collection: created });
      } else {
        const name = addForm.name.trim();
        if (name === "") {
          setAddError("请输入合集名");
          return;
        }
        const created = await addCollection("xiaohongshu", { name });
        dispatch({ type: "collections/add", collection: created });
        dispatch({ type: "explorer/open", collection: created });
      }
      setAddOpen(false);
      setAddForm({ kind: "alipan", url: "", pwd: "", name: "" });
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

  function renderRow(collection: Collection): React.JSX.Element {
    const active = state.activeCollectionId === collection.collection_id;
    const icon =
      collection.kind === "xiaohongshu" ? (
        <BookOutlined style={{ color: "#fa541c" }} />
      ) : (
        <CloudOutlined style={{ color: "#1677ff" }} />
      );
    return (
      <List.Item
        className="collection-list-item"
        style={{
          background: active ? "#e6f4ff" : undefined,
          borderRadius: 8,
          padding: "8px 10px",
          cursor: "pointer",
          border: "none",
        }}
        onClick={() => {
          handleOpen(collection);
        }}
        actions={[
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
          </Dropdown>,
        ]}
      >
        <List.Item.Meta
          avatar={icon}
          title={
            <Typography.Text
              data-testid="collection-item"
              ellipsis
              style={{ maxWidth: "100%" }}
              title={collection.name}
            >
              {collection.name}
            </Typography.Text>
          }
        />
      </List.Item>
    );
  }

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <style>{`.collection-list-item .ant-list-item-action{opacity:0;pointer-events:none;transition:opacity .15s}
.collection-list-item:hover .ant-list-item-action,.collection-list-item:focus-within .ant-list-item-action{opacity:1;pointer-events:auto}`}</style>
      <div style={{ padding: 12 }}>
        <Button
          data-testid="add-collection-btn"
          type="primary"
          icon={<PlusOutlined />}
          block
          onClick={() => {
            handleOpenAdd();
          }}
        >
          新建合集
        </Button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
        <List
          dataSource={state.collections}
          locale={{ emptyText: "暂无合集，请先新建" }}
          renderItem={renderRow}
        />
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
    </div>
  );
}
