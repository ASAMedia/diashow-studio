// Sharing over the local network (src/main/share): pupils' phones upload photos and videos to the
// laptop through a small web page, and download finished videos the user offers. Shared between
// the main process (server) and the share dialog.

/** A network interface the server can listen on. */
export interface ShareAddress {
  /** Adapter name as Windows shows it, e.g. "WLAN" or "Ethernet 2". */
  name: string
  /** IPv4 address: private (RFC 1918), or public when `public` is set. */
  address: string
  /** 'hotspot': the laptop's own mobile hotspot (192.168.137.x); 'virtual': VM / VPN / WSL adapters. */
  kind: 'wifi' | 'ethernet' | 'hotspot' | 'other' | 'virtual'
  /**
   * Not a private address (e.g. eduroam gives every device a public one): the server may be reachable
   * from outside the Wi-Fi. Listed after the private addresses; the dialog warns while it is in use.
   */
  public?: boolean
}

/** A file a phone sent. */
export interface ShareReceived {
  /** Name the pupil entered, or "Unbekannt". */
  uploader: string
  /** File name on disk (made safe and unique). */
  name: string
  path: string
  size: number
  kind: 'photo' | 'video'
  at: number
}

/** A file offered for download. */
export interface ShareOffer {
  id: string
  name: string
  path: string
  size: number
  /** Downloads started (requests from the first byte). */
  downloads: number
}

export interface ShareStatus {
  running: boolean
  /** Address the server listens on, and its port. */
  address?: string
  port?: number
  /** IPv4 interfaces, best first: private ones (Wi-Fi, Ethernet, hotspot, others), then public ones. */
  addresses: ShareAddress[]
  /** Upload page (collect photos). */
  uploadUrl?: string
  /** Download page (hand out videos). */
  downloadUrl?: string
  /** Uploads are accepted. */
  collecting: boolean
  projectId?: string
  projectName?: string
  /** Folder this project's uploads go to: <Documents>/Diashow Studio/Uploads/<project>. */
  folder?: string
  received: ShareReceived[]
  /** Uploads in progress. */
  uploading: number
  offered: ShareOffer[]
  /** Last failure (e.g. the port could not be opened). */
  error?: string
  /** Per-file limits in bytes. */
  limits: { photo: number; video: number }
}

export type ShareCommand =
  | { type: 'status' }
  /** Starts the server for this project (on `address`, else the best interface). */
  | { type: 'start'; projectId: string; projectName: string; address?: string }
  | { type: 'stop' }
  /** Moves the server to another interface (new port, same links otherwise). */
  | { type: 'address'; address: string }
  | { type: 'collect'; on: boolean }
  /** Offers files for download (existing photo / video files only). */
  | { type: 'offer'; paths: string[] }
  | { type: 'unoffer'; id: string }
  /** Lets the user pick a file to offer (open dialog). */
  | { type: 'pickOffer' }

/** Files that arrived for a project (sent after each upload). */
export interface ShareFilesEvent {
  projectId: string
  paths: string[]
}
