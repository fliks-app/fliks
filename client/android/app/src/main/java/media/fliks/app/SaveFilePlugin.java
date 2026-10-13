package media.fliks.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

/** Saves a file through the system "save as" picker; a WebView ignores anchor downloads of blobs. */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod()
    public void save(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mimeType", "application/octet-stream"))
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "file"));
        startActivityForResult(call, intent, "onPicked");
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
            out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve(new JSObject().put("saved", true));
        } catch (Exception e) {
            call.reject("Could not write the file", e);
        }
    }
}
