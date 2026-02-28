import { Link, Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Heart } from "lucide-react-native";
import Colors from "@/constants/colors";

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Not Found" }} />
      <View style={styles.container}>
        <Heart size={48} color={Colors.peachDark} />
        <Text style={styles.title}>Page not found</Text>
        <Text style={styles.subtitle}>This screen does not exist in MITR Family.</Text>
        <Link href="/" style={styles.link}>
          <Text style={styles.linkText}>Go back home</Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    backgroundColor: Colors.background,
    gap: 10,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.text,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  link: {
    marginTop: 15,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: Colors.text,
    borderRadius: 14,
  },
  linkText: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.white,
  },
});
