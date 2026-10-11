/** 侧边栏：分享列表的展示与管理入口。 */
import { useState } from "react";
import {
  App as AntdApp,
  Button,
  Divider,
  Dropdown,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Typography,
} from "antd";
import { DeleteOutlined, EllipsisOutlined, PlusOutlined } from "@ant-design/icons";
import { addShare, pickFolder, removeShare, renameShare, setConfig } from "../api";
import type { Definition, SavedShare } from "../api";
import { useStore } from "../store";

/** 添加分享弹窗内部的表单状态。 */
interface AddFormState {
  /** 用户输入的分享链接。 */
  url: string;
  /** 可选的提取密码。 */
  pwd: string;
}

/** 侧边栏组件属性。 */
export interface SidebarProps {
  /** 预留扩展，无必填项。 */
  className?: string;
}

/**
 * 分享列表侧边栏。
 *
 * @param props - 组件属性
 * @returns 侧边栏元素
 */
export default function Sidebar(props: SidebarProps): React.JSX.Element {
  const { className } = props;
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>({ url: "", pwd: "" });
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SavedShare | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);

  /** 点击条目打开 tab，已存在则激活。 */
  function handleOpen(share: SavedShare): void {
    const existing = state.tabs.find((t) => t.share_id === share.share_id);
    if (existing !== undefined) {
      dispatch({ type: "tabs/switch", tabId: existing.id });
      return;
    }
    dispatch({
      type: "tabs/add",
      tab: {
        id: share.share_id,
        share_id: share.share_id,
        share_name: share.name,
        stack: [{ file_id: "root", name: "分享根目录" }],
      },
    });
  }

  /** 提交添加分享。 */
  async function handleAddConfirm(): Promise<void> {
    const url = addForm.url.trim();
    if (url === "") {
      setAddError("请输入分享链接");
      return;
    }
    setAddLoading(true);
    setAddError("");
    try {
      const pwd = addForm.pwd.trim() === "" ? undefined : addForm.pwd.trim();
      const created = await addShare(url, pwd);
      dispatch({ type: "shares/set", shares: [...state.shares, created] });
      dispatch({
        type: "tabs/add",
        tab: {
          id: created.share_id,
          share_id: created.share_id,
          share_name: created.name,
          stack: [{ file_id: "root", name: "分享根目录" }],
        },
      });
      setAddOpen(false);
      setAddForm({ url: "", pwd: "" });
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
      void message.warning("请输入新的分享名称");
      return;
    }
    setRenameLoading(true);
    try {
      await renameShare(renameTarget.share_id, name);
      dispatch({
        type: "shares/set",
        shares: state.shares.map((s) =>
          s.share_id === renameTarget.share_id ? { ...s, name } : s,
        ),
      });
      setRenameTarget(null);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameLoading(false);
    }
  }

  /** 确认删除分享。 */
  async function handleRemove(share: SavedShare): Promise<void> {
    try {
      await removeShare(share.share_id);
      dispatch({
        type: "shares/set",
        shares: state.shares.filter((s) => s.share_id !== share.share_id),
      });
      // 同步关闭该分享已打开的页签
      const tab = state.tabs.find((t) => t.share_id === share.share_id);
      if (tab !== undefined) {
        dispatch({ type: "tabs/remove", tabId: tab.id });
      }
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

  /** 切换清晰度。 */
  async function handleDefinitionChange(value: Definition): Promise<void> {
    try {
      await setConfig({ definition: value });
      dispatch({ type: "definition/set", definition: value });
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    }
  }

  const emptyMaterial = state.materialDir === "";

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: 12 }}>
        <Button
          data-testid="add-share-btn"
          type="primary"
          icon={<PlusOutlined />}
          block
          onClick={() => {
            setAddForm({ url: "", pwd: "" });
            setAddError("");
            setAddOpen(true);
          }}
        >
          添加分享
        </Button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
        <List
          dataSource={state.shares}
          locale={{ emptyText: "暂无分享，请先添加" }}
          renderItem={(share: SavedShare) => {
            const active = state.tabs.some(
              (t) => t.share_id === share.share_id && t.id === state.activeTabId,
            );
            return (
              <List.Item
                style={{
                  background: active ? "#e6f4ff" : undefined,
                  borderRadius: 8,
                  padding: "8px 10px",
                  cursor: "pointer",
                  border: "none",
                }}
                onClick={() => {
                  handleOpen(share);
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
                            setRenameTarget(share);
                            setRenameName(share.name);
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
                  <Popconfirm
                    key="remove"
                    title="确定删除该分享吗？"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => {
                      void handleRemove(share);
                    }}
                    onCancel={(e) => {
                      e?.stopPropagation();
                    }}
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="删除分享"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Typography.Text
                      data-testid="share-item"
                      ellipsis
                      style={{ maxWidth: 130 }}
                      title={share.name}
                    >
                      {share.name}
                    </Typography.Text>
                  }
                />
              </List.Item>
            );
          }}
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
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            清晰度
          </Typography.Text>
          <Select<Definition>
            data-testid="settings-definition"
            size="small"
            style={{ width: "100%", marginTop: 4 }}
            value={state.definition}
            options={[
              { value: "AUTO", label: "自动" },
              { value: "HD", label: "高清" },
              { value: "SD", label: "标清" },
            ]}
            onChange={(v) => {
              void handleDefinitionChange(v);
            }}
          />
        </div>
      </div>
      <Modal
        title="添加分享"
        open={addOpen}
        confirmLoading={addLoading}
        okText="添加"
        cancelText="取消"
        okButtonProps={{ "data-testid": "add-share-confirm" }}
        onOk={() => {
          void handleAddConfirm();
        }}
        onCancel={() => {
          setAddOpen(false);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ marginBottom: 6 }}>分享链接</div>
            <Input
              data-testid="share-url-input"
              placeholder="https://www.alipan.com/s/xxxx"
              value={addForm.url}
              onChange={(e) => {
                setAddForm((s) => ({ ...s, url: e.target.value }));
              }}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6 }}>提取密码（可选）</div>
            <Input
              data-testid="share-pwd-input"
              placeholder="无密码可不填"
              value={addForm.pwd}
              onChange={(e) => {
                setAddForm((s) => ({ ...s, pwd: e.target.value }));
              }}
            />
          </div>
          {addError !== "" ? <Typography.Text type="danger">{addError}</Typography.Text> : null}
        </div>
      </Modal>
      <Modal
        title="重命名分享"
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
          placeholder="请输入新的分享名称"
          value={renameName}
          onChange={(e) => {
            setRenameName(e.target.value);
          }}
        />
      </Modal>
    </div>
  );
}
