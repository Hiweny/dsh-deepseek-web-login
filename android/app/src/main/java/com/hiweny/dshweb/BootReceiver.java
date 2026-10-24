package com.hiweny.dshweb;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 开机自启 / 升级后自启。 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? "" : String.valueOf(intent.getAction());
        App.Lg.i("收到广播 " + a);
        Cfg.init(context);
        Auth.init(context);
        Usage.init(context);
        KeepJobService.schedule(context);
        if (Cfg.autoStart()) {
            EngineService.start(context);
        }
    }
}
