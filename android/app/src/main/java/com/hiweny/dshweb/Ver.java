package com.hiweny.dshweb;

import android.content.Context;
import android.content.pm.PackageInfo;

public final class Ver {
    public static String versionName() {
        try {
            Context c = App.ctx();
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return pi.versionName + " (" + pi.getLongVersionCode() + ")";
        } catch (Exception e) {
            return "1.0.0";
        }
    }
}
