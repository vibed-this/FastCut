import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp, ConfigProvider, theme } from "antd";
import App from "./App";
import { StoreProvider } from "./store";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#1677ff" } }}>
      <AntApp>
        <StoreProvider>
          <App />
        </StoreProvider>
      </AntApp>
    </ConfigProvider>,
  </React.StrictMode>,
);
