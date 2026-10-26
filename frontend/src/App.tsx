import { Route, Routes } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { AdminGate } from "@/components/AdminGate";
import Home from "@/pages/Home";
import SearchTrains from "@/pages/SearchTrains";
import TrainResults from "@/pages/TrainResults";
import BookingForm from "@/pages/BookingForm";
import VirtualQueue from "@/pages/VirtualQueue";
import Bookings from "@/pages/Bookings";
import PaymentStatus from "@/pages/PaymentStatus";
import OpsDashboard from "@/pages/OpsDashboard";
import SimulationLab from "@/pages/SimulationLab";
import Architecture from "@/pages/Architecture";
import NotFound from "@/pages/NotFound";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Home />} />
        <Route path="search" element={<SearchTrains />} />
        <Route path="trains" element={<TrainResults />} />
        <Route path="book/:scheduleId" element={<BookingForm />} />
        <Route path="queue" element={<VirtualQueue />} />
        <Route path="bookings" element={<Bookings />} />
        <Route path="bookings/:reservationId" element={<Bookings />} />
        <Route path="payments" element={<PaymentStatus />} />
        <Route path="payments/:paymentId" element={<PaymentStatus />} />
        <Route
          path="ops"
          element={
            <AdminGate>
              <OpsDashboard />
            </AdminGate>
          }
        />
        <Route
          path="lab"
          element={
            <AdminGate>
              <SimulationLab />
            </AdminGate>
          }
        />
        <Route path="architecture" element={<Architecture />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
