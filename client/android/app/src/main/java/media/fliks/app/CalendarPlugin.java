package media.fliks.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.provider.CalendarContract;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Opens the calendar app on a prefilled new event; needs no permission. */
@CapacitorPlugin(name = "Calendar")
public class CalendarPlugin extends Plugin {

    @PluginMethod()
    public void addEvent(PluginCall call) {
        String url = call.getString("url", "");
        String notes = call.getString("notes", "");
        Intent intent = new Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.Events.TITLE, call.getString("title", ""))
            .putExtra(CalendarContract.Events.DESCRIPTION, notes.isEmpty() ? url : notes + "\n" + url)
            .putExtra(CalendarContract.Events.EVENT_LOCATION, url)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, call.getData().optLong("start"))
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, call.getData().optLong("end"));
        try {
            getActivity().startActivity(intent);
            call.resolve(new JSObject().put("added", true));
        } catch (ActivityNotFoundException e) {
            call.reject("No calendar app installed", e);
        }
    }
}
