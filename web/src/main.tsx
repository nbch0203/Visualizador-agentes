import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { client } from './net/socket.ts';
import './styles.css';

client.connect();
createRoot(document.getElementById('root')!).render(<App />);
