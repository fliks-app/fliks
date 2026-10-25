import SwiftUI

/// The transient line of `PartyService` (errors, refusals), over whatever screen shows it.
struct PartyNotice: View {
    @Environment(PartyService.self) private var service

    var body: some View {
        if let notice = service.notice {
            Text(notice)
                .font(.callout)
                .padding(14)
                .background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
                .padding(.bottom, 50)
                .transition(.opacity)
        }
    }
}
