package com.hiweny.dshweb;

import android.content.Context;
import android.webkit.CookieManager;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;

/** 网络小工具：局域网 IP、站点 cookie 快照。 */
public final class Net {

    private Net() {
    }

    public static String ip(Context c) {
        try {
            List<NetworkInterface> all = Collections.list(NetworkInterface.getNetworkInterfaces());
            String fallback = "";
            for (NetworkInterface ni : all) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) {
                        String ip = a.getHostAddress();
                        if (ip == null) continue;
                        if (ip.startsWith("192.168.") || ip.startsWith("10.")) return ip;
                        if (fallback.isEmpty()) fallback = ip;
                    }
                }
            }
            return fallback;
        } catch (Exception e) {
            return "";
        }
    }

    public static String cookie() {
        try {
            String c = CookieManager.getInstance().getCookie("https://chat.deepseek.com");
            return c == null ? "" : c;
        } catch (Exception e) {
            return "";
        }
    }

    public static String base(String ip) {
        return "http://" + (ip == null || ip.isEmpty() ? "127.0.0.1" : ip) + ":" + Cfg.port();
    }
}
