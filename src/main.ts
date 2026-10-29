import './styles/main.css';
import { TerraWeaveApp } from './ui/appUI';

const appRoot = document.getElementById('app');
if (!appRoot) {
  throw new Error('#app root element not found');
}

// アプリケーション起動（デバッグ確認用に window へも参照を公開）
const app = new TerraWeaveApp(appRoot);
(window as unknown as { __TERRA_WEAVE__?: TerraWeaveApp }).__TERRA_WEAVE__ = app;

