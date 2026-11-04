import './style.css';
import { startApp } from './app';
import { need } from './ui/dom';

startApp(need<HTMLElement>(document, '#app'));
