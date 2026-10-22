/**
 * main.jsx —— 设置面板的入口（React 18 + antd 5）
 *
 * 这里只做三件事：
 *   1. 挂上 ConfigProvider（深色算法 + 主色 #4ade80），全站主题只在这一处定义；
 *   2. 套一层 antd 的 <App>，让子组件能用 message / modal 的上下文（而不是静态方法）；
 *   3. 把 <PanelApp /> 渲染到 #root。
 *
 * 业务逻辑一律在 App.jsx 与 sections/ 里，入口文件保持无状态。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import PanelApp from './App.jsx';
import './panel.css';

const host = document.getElementById('root');
if (!host) throw new Error('找不到 #root 节点，panel/index.html 被改坏了');

createRoot(host).render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      algorithm: theme.darkAlgorithm,
      token: {
        colorPrimary: '#4ade80',
        borderRadius: 8,
        fontSize: 13,
        colorBgBase: '#14161a',
        colorBgContainer: '#1c1f26',
        colorBorder: 'rgba(255, 255, 255, 0.12)'
      }
    }}
  >
    <AntApp>
      <PanelApp />
    </AntApp>
  </ConfigProvider>
);
