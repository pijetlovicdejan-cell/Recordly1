import { contextBridge } from "electron";
import "./preload";
import { createControlBridgeApi } from "./controlBridgePreload";

contextBridge.exposeInMainWorld("recordlyControl", createControlBridgeApi());
